// Person cut-out: MODNet portrait matting via Transformers.js, on the CPU (wasm).
// The model downloads from the Hugging Face Hub on first use and is cached.
import * as Comlink from 'comlink';
import { AutoModel, AutoProcessor, RawImage, env, type PreTrainedModel, type Processor } from '@huggingface/transformers';
import { CUTOUT_MODEL } from '../config';
import type { Box } from '../db';
import { keepComponentsTouching } from '../lib/mask';

env.allowLocalModels = false;

type Progress = (msg: string) => void;

let loaded: Promise<{ model: PreTrainedModel; processor: Processor }> | null = null;

function load(onProgress?: Progress) {
  if (!loaded) {
    let last = 0;
    const progress_callback = (p: { status: string; file?: string; progress?: number }) => {
      if (!onProgress || p.status !== 'progress' || !p.file) return;
      const now = Date.now();
      if (now - last < 250 && (p.progress ?? 0) < 100) return;
      last = now;
      onProgress(`Downloading cut-out model (${p.file.split('/').pop()}): ${Math.round(p.progress ?? 0)}%`);
    };
    loaded = Promise.all([
      AutoModel.from_pretrained(CUTOUT_MODEL, { device: 'wasm', dtype: 'fp32', progress_callback }),
      AutoProcessor.from_pretrained(CUTOUT_MODEL),
    ]).then(([model, processor]) => ({ model, processor }));
    loaded.catch(() => (loaded = null)); // allow a retry after a failed download
  }
  return loaded;
}

export interface CutoutResult {
  alpha: Uint8Array; // width*height, 0..255
  width: number;
  height: number;
  ms: number; // matting time
}

const api = {
  async preload(onProgress?: Progress) {
    await load(onProgress);
  },

  /** Soft alpha mask for the person whose face is at faceBox (crop pixels). */
  async cutout(image: Blob, faceBox: Box, onProgress?: Progress): Promise<CutoutResult> {
    const { model, processor } = await load(onProgress);
    const img = await RawImage.fromBlob(image);
    const { width, height } = img;
    const t0 = performance.now();
    const { pixel_values } = await processor(img);
    const { output } = await model({ input: pixel_values });
    const matte = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height);
    const ms = performance.now() - t0;
    // Keep only the blobs connected to the chosen face (drops other people and clutter).
    const alpha = keepComponentsTouching(new Uint8Array(matte.data), width, height, faceBox);
    return Comlink.transfer({ alpha, width, height, ms }, [alpha.buffer]);
  },
};

export type CutoutApi = typeof api;
Comlink.expose(api);
