import * as Comlink from 'comlink';
import { getSettings, updateSettings } from '../settings';
import type { FaceApi } from './face.worker';
import type { ImageApi } from './image.worker';
import type { SegApi } from './seg.worker';

let face: Comlink.Remote<FaceApi> | null = null;
let images: Comlink.Remote<ImageApi>[] = [];

/** A small pool of photo-resizing workers; decoding big photos is CPU-bound. */
export function imageWorkers(): Comlink.Remote<ImageApi>[] {
  if (!images.length) {
    const n = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
    images = Array.from({ length: n }, () =>
      Comlink.wrap<ImageApi>(new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' })),
    );
  }
  return images;
}
let seg: { remote: Comlink.Remote<SegApi>; worker: Worker; gpu: boolean } | null = null;

export function faceWorker(): Comlink.Remote<FaceApi> {
  if (!face) {
    face = Comlink.wrap<FaceApi>(new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' }));
  }
  return face;
}

/**
 * The cut-out worker. It runs on the CPU unless the user opts into the GPU in
 * the Lab tab: on some GPUs these models silently return wrong masks, and the
 * CPU path (MODNet) is fast enough.
 */
export function segWorker(): Comlink.Remote<SegApi> {
  const gpu = getSettings().cutoutDevice === 'gpu';
  if (seg && seg.gpu !== gpu) {
    seg.worker.terminate();
    seg = null;
  }
  if (!seg) {
    const worker = new Worker(new URL('./seg.worker.ts', import.meta.url), { type: 'module' });
    const remote = Comlink.wrap<SegApi>(worker);
    if (!gpu) void remote.forceCpu();
    seg = { remote, worker, gpu };
  }
  return seg.remote;
}

/** After a GPU failure: switch the cut-out step to the CPU. Returns false if already there. */
export function fallBackToCpu(): boolean {
  if (getSettings().cutoutDevice === 'cpu') return false;
  updateSettings({ cutoutDevice: 'cpu' });
  seg?.worker.terminate();
  seg = null;
  return true;
}
