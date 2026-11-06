// Person cut-out via Transformers.js on the CPU (wasm): MODNet portrait matting
// for soft edges, plus face parsing to shape face stickers to the head.
// Models download from the Hugging Face Hub on first use and are cached.
import * as Comlink from 'comlink';
import { AutoModel, AutoProcessor, RawImage, env, type PreTrainedModel, type Processor } from '@huggingface/transformers';
import { CUTOUT_MODEL, PARSE_SIZE, PARSER_MODEL } from '../config';
import type { Box } from '../db';
import { fillHoles, headMask, keepComponentsTouching, trimToHead } from '../lib/mask';

env.allowLocalModels = false;

type Progress = (msg: string) => void;
type Loaded = { model: PreTrainedModel; processor: Processor };

const cache = new Map<string, Promise<Loaded>>();

function load(id: string, dtype: 'fp32' | 'q8', label: string, onProgress?: Progress): Promise<Loaded> {
  let p = cache.get(id);
  if (!p) {
    let last = 0;
    const progress_callback = (e: { status: string; file?: string; progress?: number }) => {
      if (!onProgress || e.status !== 'progress' || !e.file) return;
      const now = Date.now();
      if (now - last < 250 && (e.progress ?? 0) < 100) return;
      last = now;
      onProgress(`Downloading ${label} (${e.file.split('/').pop()}): ${Math.round(e.progress ?? 0)}%`);
    };
    p = Promise.all([
      AutoModel.from_pretrained(id, { device: 'wasm', dtype, progress_callback }),
      AutoProcessor.from_pretrained(id),
    ]).then(([model, processor]) => ({ model, processor }));
    p.catch(() => cache.delete(id)); // allow a retry after a failed download
    cache.set(id, p);
  }
  return p;
}

const matter = (onProgress?: Progress) => load(CUTOUT_MODEL, 'fp32', 'cut-out model', onProgress);
const parser = (onProgress?: Progress) => load(PARSER_MODEL, 'q8', 'face-parsing model', onProgress);

/** Per-pixel face-parsing class at PARSE_SIZE/4 resolution. */
async function parseFace(img: RawImage) {
  const { model, processor } = await parser();
  (processor as unknown as { image_processor: { size: unknown } }).image_processor.size = {
    height: PARSE_SIZE,
    width: PARSE_SIZE,
  };
  const { logits } = await model(await processor(img)); // [1, classes, h, w]
  const [, n, h, w] = logits.dims as number[];
  const data = logits.data as Float32Array;
  const plane = h * w;
  const labels = new Uint8Array(plane);
  for (let i = 0; i < plane; i++) {
    let best = 0;
    for (let c = 1; c < n; c++) if (data[c * plane + i] > data[best * plane + i]) best = c;
    labels[i] = best;
  }
  return { labels, w, h };
}

export interface CutoutResult {
  alpha: Uint8Array; // width*height, 0..255
  width: number;
  height: number;
  ms: { matte: number; parse: number };
}

const api = {
  async preload(head: boolean, onProgress?: Progress) {
    await matter(onProgress);
    if (head) await parser(onProgress).catch((e) => console.warn('Face parsing unavailable', e));
  },

  /**
   * Soft alpha mask for the person whose face is at faceBox (crop pixels).
   * head: shape it to the head (face stickers).
   */
  async cutout(image: Blob, faceBox: Box, head: boolean, onProgress?: Progress): Promise<CutoutResult> {
    const { model, processor } = await matter(onProgress);
    const img = await RawImage.fromBlob(image);
    const { width, height } = img;
    const t0 = performance.now();
    const { pixel_values } = await processor(img);
    const { output } = await model({ input: pixel_values });
    const matte = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height);
    let alpha: Uint8Array = new Uint8Array(matte.data);
    const t1 = performance.now();

    if (head) {
      try {
        const p = await parseFace(img);
        const mask = headMask(p.labels, p.w, p.h, width, height, faceBox);
        for (let i = 0; i < alpha.length; i++) alpha[i] = (alpha[i] * mask[i]) / 255;
      } catch (e) {
        console.warn('Face parsing failed; using an oval head trim', e);
        trimToHead(alpha, width, height, faceBox);
      }
    }
    const t2 = performance.now();

    // Last, keep only the blobs connected to the chosen face (drops other people and clutter).
    alpha = keepComponentsTouching(alpha, width, height, faceBox);
    // A head has no see-through gaps; a body can (between an arm and the side).
    if (head) fillHoles(alpha, width, height);
    return Comlink.transfer({ alpha, width, height, ms: { matte: t1 - t0, parse: t2 - t1 } }, [alpha.buffer]);
  },
};

export type CutoutApi = typeof api;
Comlink.expose(api);
