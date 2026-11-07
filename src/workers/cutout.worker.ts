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

// Below this tilt both models cope fine; above it the crop is turned upright first.
const MAX_ROLL = (10 * Math.PI) / 180;

/** Draws src rotated by `angle` around the face centre (canvas pixels outside become clear). */
function rotated(src: CanvasImageSource, w: number, h: number, face: Box, angle: number) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const cx = (face[0] + face[2]) / 2, cy = (face[1] + face[3]) / 2;
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.translate(-cx, -cy);
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

/** Rotates a w*h alpha mask by `angle` around the face centre. */
function rotateAlpha(alpha: Uint8Array, w: number, h: number, face: Box, angle: number): Uint8Array {
  const src = new OffscreenCanvas(w, h);
  const sctx = src.getContext('2d')!;
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = alpha[i];
  sctx.putImageData(img, 0, 0);
  const d = rotated(src, w, h, face, angle).getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i * 4 + 3];
  return out;
}

/**
 * Adds held things to the alpha: each object's outline (keep), and the hands
 * right around it, taken from the person's matte before the head trim.
 */
function addHeld(alpha: Uint8Array, keep: Uint8Array, person: Uint8Array | null, w: number, h: number) {
  const reach = Math.max(4, Math.round(Math.max(w, h) * 0.04));
  const near = person ? dilate(keep, w, h, reach) : null;
  for (let i = 0; i < alpha.length; i++) {
    let v = keep[i];
    if (near && near[i] && person![i] > v) v = Math.min(person![i], near[i]);
    if (v > alpha[i]) alpha[i] = v;
  }
}

/** Soft dilation: box max over r (separable), as 0..255. */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[y * w + k] > m) m = src[y * w + k];
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
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
   * radians (eye line angle).
   *
   * Both models were trained on upright portraits: on a baby lying down the
   * matte cuts into the chin and cheeks and the parser loses the face. So a
   * tilted face crop is turned upright, cut out, and the mask turned back.
   *
   * held: boxes (crop pixels) of things the person holds; keep: their outline
   * (w*h, 0..255). It is added back after the head trim, with the hands around
   * it, so a bottle at the mouth doesn't leave a hole in the face.
   */
  async cutout(
    image: Blob,
    faceBox: Box,
    head: boolean,
    roll: number,
    held: Box[],
    keep: Uint8Array | null,
    onProgress?: Progress,
  ): Promise<CutoutResult> {
    const { model, processor } = await matter(onProgress);
    const src = await createImageBitmap(image);
    const { width, height } = src;
    const turn = head && Math.abs(roll) > MAX_ROLL ? roll : 0;
    const img = RawImage.fromCanvas(rotated(src, width, height, faceBox, -turn));
    src.close();
    const t0 = performance.now();
    const { pixel_values } = await processor(img);
    const { output } = await model({ input: pixel_values });
    const matte = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height);
    let alpha: Uint8Array = new Uint8Array(matte.data);
    // The person's matte before it is trimmed to the head: the hands holding a
    // bottle or toy are taken from it.
    let person: Uint8Array | null = held.length ? alpha.slice() : null;
    const t1 = performance.now();

    if (head) {
      try {
        const p = await parseFace(img);
        const mask = headMask(p, width, height, faceBox, { data: img.data, channels: img.channels });
        for (let i = 0; i < alpha.length; i++) alpha[i] = (alpha[i] * mask[i]) / 255;
      } catch (e) {
        console.warn('Face parsing failed; using an oval head trim', e);
        trimToHead(alpha, width, height, faceBox);
      }
    }
    const t2 = performance.now();
    if (turn) {
      alpha = rotateAlpha(alpha, width, height, faceBox, turn);
      if (person) person = rotateAlpha(person, width, height, faceBox, turn);
    }

    if (keep) addHeld(alpha, keep, person, width, height);

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
