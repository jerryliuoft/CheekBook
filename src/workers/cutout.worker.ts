// Person cut-out via Transformers.js on the CPU (wasm): MODNet portrait matting
// for soft edges, plus face parsing to shape face stickers to the head.
// Models download from the Hugging Face Hub on first use and are cached.
import * as Comlink from 'comlink';
import { AutoModel, AutoProcessor, RawImage, env, type PreTrainedModel, type Processor } from '@huggingface/transformers';
import { CUTOUT_MODEL, PARSE_SIZE, PARSER_MODEL } from '../config';
import type { Box } from '../db';
import { headMask, keepComponentsTouching, solidify, trimToHead, type ParseResult } from '../lib/mask';

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

/** Face-parsing class scores at PARSE_SIZE/4 resolution. */
async function parseFace(img: RawImage): Promise<ParseResult> {
  const { model, processor } = await parser();
  (processor as unknown as { image_processor: { size: unknown } }).image_processor.size = {
    height: PARSE_SIZE,
    width: PARSE_SIZE,
  };
  const { logits } = await model(await processor(img)); // [1, classes, h, w]
  const [, classes, lh, lw] = logits.dims as number[];
  return { logits: logits.data as Float32Array, classes, lw, lh };
}

// Below this tilt the parser copes fine; above it the face is turned upright first.
const MAX_ROLL = (10 * Math.PI) / 180;

/** The crop rotated by -roll around the face centre, so the face is upright. */
async function uprighted(image: Blob, w: number, h: number, face: Box, roll: number) {
  const bmp = await createImageBitmap(image);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const cx = (face[0] + face[2]) / 2, cy = (face[1] + face[3]) / 2;
  ctx.translate(cx, cy);
  ctx.rotate(-roll);
  ctx.translate(-cx, -cy);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return RawImage.fromCanvas(canvas);
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
   * head: shape it to the head (face stickers). roll: the face's tilt in
   * radians (eye line angle), so tilted faces can be parsed upright.
   */
  async cutout(image: Blob, faceBox: Box, head: boolean, roll: number, onProgress?: Progress): Promise<CutoutResult> {
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
        // The parser only knows upright faces: straighten tilted ones first.
        const turn = Math.abs(roll) > MAX_ROLL ? roll : 0;
        const p = await parseFace(turn ? await uprighted(image, width, height, faceBox, turn) : img);
        const mask = headMask(p, width, height, faceBox, turn, { data: img.data, channels: img.channels });
        for (let i = 0; i < alpha.length; i++) alpha[i] = (alpha[i] * mask[i]) / 255;
      } catch (e) {
        console.warn('Face parsing failed; using an oval head trim', e);
        trimToHead(alpha, width, height, faceBox);
      }
    }
    const t2 = performance.now();

    // Last, keep only the blobs connected to the chosen face (drops other people and clutter).
    alpha = keepComponentsTouching(alpha, width, height, faceBox);
    // A head has no see-through gaps (a body can, between an arm and the side):
    // make it solid inside, so the sticker's white border can't show through.
    if (head) solidify(alpha, width, height, Math.max(3, Math.round(Math.max(width, height) / 160)));
    return Comlink.transfer({ alpha, width, height, ms: { matte: t1 - t0, parse: t2 - t1 } }, [alpha.buffer]);
  },
};

export type CutoutApi = typeof api;
Comlink.expose(api);
