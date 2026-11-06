// What the app keeps in the browser, and clean-up of AI model files it no
// longer uses (Transformers.js caches every model it ever downloaded).
import { CUTOUT_MODEL, PARSER_MODEL } from '../config';

const MODEL_CACHE = 'transformers-cache';
const IN_USE = new Set([CUTOUT_MODEL, PARSER_MODEL]);

/** Hugging Face model id in a cached URL, e.g. "Xenova/modnet"; null for other files. */
function modelId(url: string): string | null {
  return url.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//)?.[1] ?? null;
}

async function size(cache: Cache, req: Request): Promise<number> {
  const res = await cache.match(req);
  if (!res) return 0;
  const len = Number(res.headers.get('content-length'));
  return len > 0 ? len : (await res.blob()).size;
}

export interface StorageReport {
  data: number; // photos, faces, stickers (bytes)
  models: number; // all downloaded model files
  unused: number; // model files the app no longer uses
}

export async function storageReport(): Promise<StorageReport> {
  const est = (await navigator.storage?.estimate?.()) ?? {};
  let models = 0, unused = 0;
  if ('caches' in self && (await caches.has(MODEL_CACHE))) {
    const cache = await caches.open(MODEL_CACHE);
    for (const req of await cache.keys()) {
      const n = await size(cache, req);
      models += n;
      const id = modelId(req.url);
      if (id && !IN_USE.has(id)) unused += n;
    }
  }
  const details = (est as { usageDetails?: { indexedDB?: number } }).usageDetails;
  const data = details?.indexedDB ?? Math.max(0, (est.usage ?? 0) - models);
  return { data, models, unused };
}

/** Deletes cached model files the app no longer uses; returns bytes freed. */
export async function removeUnusedModels(): Promise<number> {
  if (!('caches' in self) || !(await caches.has(MODEL_CACHE))) return 0;
  const cache = await caches.open(MODEL_CACHE);
  let freed = 0;
  for (const req of await cache.keys()) {
    const id = modelId(req.url);
    if (id && !IN_USE.has(id)) {
      freed += await size(cache, req);
      await cache.delete(req);
    }
  }
  return freed;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
