// Face detection (SCRFD) and face fingerprints (ArcFace), run with onnxruntime-web.
import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web/webgpu';
import { FACE_MODELS } from '../config';
import type { Box } from '../db';
import { nms, similarityTransform } from '../lib/geometry';
import { modelBytes } from '../lib/modelCache';
import { normalized } from '../lib/util';

const DET_SIZE = 640;
const STRIDES = [8, 16, 32];
const ANCHORS_PER_CELL = 2;
const NMS_IOU = 0.4;

// ArcFace canonical 5-point template for a 112x112 crop.
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let det: ort.InferenceSession | null = null;
let rec: ort.InferenceSession | null = null;
let provider = 'wasm';

// Load onnxruntime's wasm engine (~28 MB) from jsDelivr, as Transformers.js
// does for the cut-out worker, so it never counts against this site's hosting.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;

async function createSession(url: string): Promise<ort.InferenceSession> {
  const buf = await modelBytes(url);
  if ('gpu' in navigator) {
    try {
      const s = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'] });
      provider = 'webgpu';
      return s;
    } catch (e) {
      console.warn('WebGPU session failed, falling back to wasm', e);
    }
  }
  provider = 'wasm';
  return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
}

export interface DetectedFace {
  box: Box;
  kps: number[];
  score: number;
  embedding: Float32Array;
  thumb: Blob;
}

export interface AnalyzeResult {
  faces: DetectedFace[];
  ms: { detect: number; embed: number };
}

function toCHW(data: Uint8ClampedArray, w: number, h: number, mean: number, std: number): Float32Array {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 4] - mean) / std;
    out[i + plane] = (data[i * 4 + 1] - mean) / std;
    out[i + 2 * plane] = (data[i * 4 + 2] - mean) / std;
  }
  return out;
}

async function detect(bmp: ImageBitmap, scoreThreshold: number) {
  const scale = Math.min(DET_SIZE / bmp.width, DET_SIZE / bmp.height);
  const canvas = new OffscreenCanvas(DET_SIZE, DET_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000'; // theme-ok: model input, not UI
  ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  ctx.drawImage(bmp, 0, 0, Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const pixels = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;
  const input = new ort.Tensor('float32', toCHW(pixels, DET_SIZE, DET_SIZE, 127.5, 128), [1, 3, DET_SIZE, DET_SIZE]);
  const out = await det!.run({ [det!.inputNames[0]]: input });
  const names = det!.outputNames; // [scores x3, bbox x3, kps x3]

  const boxes: Box[] = [];
  const scores: number[] = [];
  const kpss: number[][] = [];
  STRIDES.forEach((stride, si) => {
    const sc = out[names[si]].data as Float32Array;
    const bb = out[names[si + 3]].data as Float32Array;
    const kp = out[names[si + 6]].data as Float32Array;
    const cols = DET_SIZE / stride;
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] < scoreThreshold) continue;
      const cell = Math.floor(i / ANCHORS_PER_CELL);
      const cx = (cell % cols) * stride;
      const cy = Math.floor(cell / cols) * stride;
      boxes.push([
        (cx - bb[i * 4] * stride) / scale,
        (cy - bb[i * 4 + 1] * stride) / scale,
        (cx + bb[i * 4 + 2] * stride) / scale,
        (cy + bb[i * 4 + 3] * stride) / scale,
      ]);
      const k: number[] = [];
      for (let j = 0; j < 5; j++) {
        k.push((cx + kp[i * 10 + j * 2] * stride) / scale, (cy + kp[i * 10 + j * 2 + 1] * stride) / scale);
      }
      kpss.push(k);
      scores.push(sc[i]);
    }
  });
  return nms(boxes, scores, NMS_IOU).map((i) => ({ box: boxes[i], kps: kpss[i], score: scores[i] }));
}

async function embed(bmp: ImageBitmap, kps: number[]): Promise<Float32Array> {
  const src = [0, 1, 2, 3, 4].map((j) => [kps[j * 2], kps[j * 2 + 1]]);
  const [p, q, tx, ty] = similarityTransform(src, ARCFACE_TEMPLATE);
  const canvas = new OffscreenCanvas(112, 112);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(p, q, -q, p, tx, ty);
  ctx.drawImage(bmp, 0, 0);
  const pixels = ctx.getImageData(0, 0, 112, 112).data;
  const input = new ort.Tensor('float32', toCHW(pixels, 112, 112, 127.5, 127.5), [1, 3, 112, 112]);
  const out = await rec!.run({ [rec!.inputNames[0]]: input });
  return normalized(out[rec!.outputNames[0]].data as Float32Array);
}

async function faceThumb(bmp: ImageBitmap, box: Box): Promise<Blob> {
  const size = Math.max(box[2] - box[0], box[3] - box[1]) * 1.5;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const canvas = new OffscreenCanvas(160, 160);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#eee'; // theme-ok: padding behind face thumbnails
  ctx.fillRect(0, 0, 160, 160);
  ctx.drawImage(bmp, cx - size / 2, cy - size / 2, size, size, 0, 0, 160, 160);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

const api = {
  async init(): Promise<{ provider: string; threads: number }> {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    if (!det) det = await createSession(FACE_MODELS.detector);
    if (!rec) rec = await createSession(FACE_MODELS.recognizer);
    return { provider, threads: ort.env.wasm.numThreads as number };
  },

  async analyze(blob: Blob, opts: { scoreThreshold: number; minFacePx: number }): Promise<AnalyzeResult> {
    if (!det || !rec) await api.init();
    const bmp = await createImageBitmap(blob);
    const t0 = performance.now();
    const found = (await detect(bmp, opts.scoreThreshold)).filter(
      (f) => Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]) >= opts.minFacePx,
    );
    const t1 = performance.now();
    const faces: DetectedFace[] = [];
    for (const f of found) {
      faces.push({ ...f, embedding: await embed(bmp, f.kps), thumb: await faceThumb(bmp, f.box) });
    }
    const t2 = performance.now();
    bmp.close();
    return { faces, ms: { detect: t1 - t0, embed: t2 - t1 } };
  },
};

export type FaceApi = typeof api;
Comlink.expose(api);
