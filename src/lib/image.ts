import type { Box } from '../db';

/**
 * Cuts a rectangle out of an image, scaled down so its longest side is at most
 * maxSide; areas outside the image stay transparent. `scale` maps photo pixels
 * to crop pixels.
 */
export async function cropImage(
  src: Blob,
  rect: Box,
  maxSide = Infinity,
): Promise<{ blob: Blob; width: number; height: number; scale: number }> {
  const bmp = await createImageBitmap(src);
  const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
  const scale = Math.min(1, maxSide / Math.max(rw, rh));
  const width = Math.round(rw * scale);
  const height = Math.round(rh * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, rect[0], rect[1], rw, rh, 0, 0, width, height);
  bmp.close();
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width, height, scale };
}

export function isImageFile(f: File): boolean {
  return /^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(f.type) || /\.(jpe?g|png|webp|avif)$/i.test(f.name);
}
