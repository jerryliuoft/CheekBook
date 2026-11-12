// Model weights come from other people's hosting (Hugging Face, Google), not
// from this site. Each file is kept in Cache Storage after the first download,
// so returning visitors never fetch it again. Works in workers too.

const CACHE = 'cheekbook-models-v1';

/** The model file's bytes, from the cache when we have it. */
export async function modelBytes(url: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null; // no Cache Storage (private window, blocked storage): just download
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (cache) {
    try {
      await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch (e) {
      console.warn('Could not cache model', url, e);
    }
  }
  return new Uint8Array(buf);
}
