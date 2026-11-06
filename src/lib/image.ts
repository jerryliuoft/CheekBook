import { useEffect, useState } from 'react';
import type { Box } from '../db';

/** Decodes an image file (EXIF orientation applied) and returns a downscaled JPEG. */
export async function normalizeImage(file: Blob, maxSide: number, quality = 0.9) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width, height };
}

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
