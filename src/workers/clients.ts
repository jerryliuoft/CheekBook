import * as Comlink from 'comlink';
import type { CutoutApi } from './cutout.worker';
import type { FaceApi } from './face.worker';
import type { ImageApi } from './image.worker';

// One lazily created instance of each worker for the app's lifetime.

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export const faceWorker = lazy(() =>
  Comlink.wrap<FaceApi>(new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' })),
);

export const cutoutWorker = lazy(() =>
  Comlink.wrap<CutoutApi>(new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module' })),
);

/** A small pool of canvas workers (photo resizing, crops, sticker drawing). */
export const imageWorkers = lazy(() => {
  const n = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
  return Array.from({ length: n }, () =>
    Comlink.wrap<ImageApi>(new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' })),
  );
});
