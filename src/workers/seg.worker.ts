// Person cut-out: SAM picks out the chosen person, BiRefNet refines the edges.
// Runs Transformers.js; models download from the Hugging Face Hub on first use.
import * as Comlink from 'comlink';
import {
  AutoModel,
  AutoProcessor,
  RawImage,
  Sam2Model,
  Sam3TrackerModel,
  env,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers';
import { MATTERS, SEGMENTERS, type MatterKey, type SegmenterKey } from '../config';
import type { Box } from '../db';
import { keepComponentsTouching } from '../lib/mask';

env.allowLocalModels = false;

type Device = 'webgpu' | 'wasm';
let device: Device = 'wasm';
let deviceChecked = false;
let gpuInfo = '';

// Each worker picks one device for its whole life. If a model fails on the GPU,
// the main thread throws this worker away and starts a CPU-only one, because
// Transformers.js caches sessions per model file and would keep reusing the
// broken GPU session.
async function pickDevice(): Promise<Device> {
  if (deviceChecked) return device;
  deviceChecked = true;
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      // Ask for the adapter's real limits; WebGPU's defaults are lower than many GPUs allow.
      const limits = adapter.limits as unknown as Record<string, number>;
      const requiredLimits: Record<string, number> = {};
      for (const k of ['maxStorageBuffersPerShaderStage', 'maxStorageBufferBindingSize', 'maxBufferSize']) {
        if (limits[k]) requiredLimits[k] = limits[k];
      }
      const gpuDevice = await adapter.requestDevice({ requiredLimits });
      (env.backends.onnx as { webgpu?: { device?: unknown } }).webgpu!.device = gpuDevice;
      gpuInfo = `${requiredLimits.maxStorageBuffersPerShaderStage} storage buffers per shader`;
      device = 'webgpu';
    }
  } catch (e) {
    console.warn('WebGPU unavailable', e);
    device = 'wasm';
  }
  return device;
}

let matter: { key: MatterKey; model: PreTrainedModel; processor: Processor } | null = null;
// SAM processors expose post_process_masks, which the generic Processor type omits.
type SamProcessorLike = Processor & { post_process_masks: (...args: unknown[]) => Promise<{ data: unknown }[]> };
let segmenter: { key: SegmenterKey; model: PreTrainedModel; processor: SamProcessorLike } | null = null;

type Progress = (msg: string) => void;

function progressCallback(label: string, onProgress?: Progress) {
  let last = 0;
  return (p: { status: string; file?: string; progress?: number }) => {
    if (!onProgress || p.status !== 'progress' || !p.file) return;
    const now = Date.now();
    if (now - last < 250 && (p.progress ?? 0) < 100) return;
    last = now;
    onProgress(`Downloading ${label} (${p.file.split('/').pop()}): ${Math.round(p.progress ?? 0)}%`);
  };
}

async function loadMatter(key: MatterKey, onProgress?: Progress) {
  if (matter?.key === key) return matter;
  const dev = await pickDevice();
  const id = MATTERS[key].id;
  const model = await AutoModel.from_pretrained(id, {
    device: dev,
    dtype: dev === 'webgpu' && MATTERS[key].kind === 'birefnet' ? 'fp16' : 'fp32',
    progress_callback: progressCallback('matting model', onProgress),
  });
  const processor = await AutoProcessor.from_pretrained(id);
  matter = { key, model, processor };
  return matter;
}

async function loadSegmenter(key: SegmenterKey, onProgress?: Progress) {
  if (key === 'none') return null;
  if (segmenter?.key === key) return segmenter;
  const dev = await pickDevice();
  const cfg = SEGMENTERS[key];
  const Cls = cfg.kind === 'sam3' ? Sam3TrackerModel : Sam2Model;
  const model = await Cls.from_pretrained(cfg.id, {
    device: dev,
    dtype: dev === 'webgpu' ? { vision_encoder: 'fp16', prompt_encoder_mask_decoder: 'fp32' } : 'q8',
    progress_callback: progressCallback('segmentation model', onProgress),
  });
  const processor = (await AutoProcessor.from_pretrained(cfg.id)) as SamProcessorLike;
  segmenter = { key, model, processor };
  return segmenter;
}

export interface CutoutRequest {
  image: Blob; // the crop
  faceBox: Box; // in crop pixels
  bodyBox: Box; // in crop pixels
  segmenter: SegmenterKey;
  matter: MatterKey;
}

export interface CutoutResult {
  alpha: Uint8Array; // width*height, 0..255
  width: number;
  height: number;
  ms: { matte: number; segment: number };
  usedSegmenter: boolean;
  device: Device;
}

const api = {
  async device() {
    const d = await pickDevice();
    return { device: d, gpuInfo };
  },

  /** Must be called before anything loads. */
  forceCpu() {
    deviceChecked = true;
    device = 'wasm';
  },

  async preload(seg: SegmenterKey, mat: MatterKey, onProgress?: Progress) {
    await loadMatter(mat, onProgress);
    await loadSegmenter(seg, onProgress);
    return device;
  },

  async cutout(req: CutoutRequest, onProgress?: Progress): Promise<CutoutResult> {
    const image = await RawImage.fromBlob(req.image);
    const { width, height } = image;

    // 1. Matting: soft alpha for everything salient in the crop.
    const t0 = performance.now();
    const m = await loadMatter(req.matter, onProgress);
    const { pixel_values } = await m.processor(image);
    let alphaTensor;
    if (MATTERS[m.key].kind === 'modnet') {
      const { output } = await m.model({ input: pixel_values });
      alphaTensor = output[0].mul(255).to('uint8');
    } else {
      const { output_image } = await m.model({ input_image: pixel_values });
      alphaTensor = output_image[0].sigmoid().mul(255).to('uint8');
    }
    const matte = await RawImage.fromTensor(alphaTensor).resize(width, height);
    const alpha = new Uint8Array(matte.data);
    const t1 = performance.now();

    // 2. Segmentation: mask of just the chosen person, used to drop other people.
    let usedSegmenter = false;
    try {
      const s = await loadSegmenter(req.segmenter, onProgress);
      if (s) {
        const fx = (req.faceBox[0] + req.faceBox[2]) / 2;
        const fy = (req.faceBox[1] + req.faceBox[3]) / 2;
        const inputs = await s.processor(image, {
          input_points: [[[[fx, fy]]]],
          input_labels: [[[1]]],
          input_boxes: [[req.bodyBox]],
        });
        const out = await s.model(inputs);
        const masks = await s.processor.post_process_masks(
          out.pred_masks,
          inputs.original_sizes,
          inputs.reshaped_input_sizes,
        );
        const scores = out.iou_scores.data as Float32Array;
        let best = 0;
        for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
        const maskData = masks[0].data as Uint8Array; // [1, n, H, W]
        const plane = width * height;
        const personMask = maskData.subarray(best * plane, (best + 1) * plane);
        // Grow the SAM mask a little so BiRefNet's soft hair edges survive.
        const grown = dilate(personMask, width, height, Math.max(4, Math.round(Math.max(width, height) * 0.02)));
        for (let i = 0; i < plane; i++) if (!grown[i]) alpha[i] = 0;
        usedSegmenter = true;
      }
    } catch (e) {
      console.warn('Segmenter failed; using matting only', e);
    }
    const t2 = performance.now();

    // 3. Keep only the blobs connected to the chosen face.
    const cleaned = keepComponentsTouching(alpha, width, height, req.faceBox);
    return Comlink.transfer(
      { alpha: cleaned, width, height, ms: { matte: t1 - t0, segment: t2 - t1 }, usedSegmenter, device },
      [cleaned.buffer],
    );
  },
};

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // Separable max filter (square structuring element).
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(r, w); x++) count += mask[row + x] ? 1 : 0;
    for (let x = 0; x < w; x++) {
      if (x + r < w && mask[row + x + r]) count++;
      if (x - r - 1 >= 0 && mask[row + x - r - 1]) count--;
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

export type SegApi = typeof api;
Comlink.expose(api);
