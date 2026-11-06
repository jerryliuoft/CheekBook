import { useEffect, useState } from 'react';

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
