import { useEffect, useState } from 'react';
import type { Box } from '../db';

/** Cuts a rectangle out of an image; areas outside the image stay transparent. */
export async function cropImage(src: Blob, rect: Box): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(src);
  const width = Math.round(rect[2] - rect[0]);
  const height = Math.round(rect[3] - rect[1]);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, -rect[0], -rect[1]);
  bmp.close();
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width, height };
}

export function isImageFile(f: File): boolean {
  return /^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(f.type) || /\.(jpe?g|png|webp|avif)$/i.test(f.name);
}

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | undefined | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
