import { useEffect, useMemo, useState } from 'react';
import type { Caption, Sticker } from '../db';
import { captionTilt, composeSticker } from '../lib/caption';

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | undefined | null): string | undefined {
  const [entry, setEntry] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // The URL is an external resource that must be created and revoked in step with the blob.
    // oxlint-disable-next-line react/set-state-in-effect
    setEntry({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return blob && entry?.blob === blob ? entry.url : undefined;
}

/**
 * Decodes a blob into an ImageBitmap for canvas drawing. IndexedDB hands back a
 * new Blob object on every read, so the previous bitmap stays on screen until
 * the new one is decoded (no flicker after a sticker is moved).
 */
export function useImageBitmap(blob: Blob | undefined | null): ImageBitmap | undefined {
  const [bmp, setBmp] = useState<ImageBitmap>();
  useEffect(() => {
    if (!blob) return;
    let cancelled = false;
    createImageBitmap(blob).then((b) => !cancelled && setBmp(b));
    return () => {
      cancelled = true;
    };
  }, [blob]);
  return bmp;
}

/**
 * A sticker ready to draw: the cut-out alone, or the cut-out with its caption
 * on a bigger canvas. `ax`/`ay` is the cut-out's centre in that image, and
 * `w`/`h` are the cut-out's own size, so callers can keep it anchored.
 */
export interface StickerArt {
  image: ImageBitmap | HTMLCanvasElement;
  ax: number;
  ay: number;
  w: number;
  h: number;
}

export function useStickerArt(sticker: Sticker): StickerArt | undefined {
  const bmp = useImageBitmap(sticker.blob);
  const key = sticker.caption?.text.trim() ? JSON.stringify(sticker.caption) : '';
  const [composed, setComposed] = useState<{ key: string; art: StickerArt }>();
  useEffect(() => {
    if (!bmp || !key) return;
    const stale = new AbortController();
    composeSticker(bmp, JSON.parse(key) as Caption, captionTilt(sticker.id)).then(({ canvas, ax, ay }) => {
      if (!stale.signal.aborted) setComposed({ key, art: { image: canvas, ax, ay, w: bmp.width, h: bmp.height } });
    });
    return () => stale.abort();
  }, [bmp, key, sticker.id]);
  const plain = useMemo(
    () => bmp && { image: bmp, ax: bmp.width / 2, ay: bmp.height / 2, w: bmp.width, h: bmp.height },
    [bmp],
  );
  if (!key) return plain;
  // Keep showing the last drawing while a new caption is drawn (no flicker while typing).
  return composed?.art ?? plain;
}
