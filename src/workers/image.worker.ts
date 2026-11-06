import * as Comlink from 'comlink';
import { cropImage } from '../lib/image';
import { makeSticker } from '../lib/sticker';

/**
 * Canvas work (photo resizing, sticker drawing) runs here rather than on the
 * page: Chrome defers main-thread image encoding until it is idle (about 1 s
 * per JPEG), while in a worker the same encode takes 50–80 ms.
 */

async function encode(src: CanvasImageSource, width: number, height: number, quality: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  return { canvas, blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }) };
}

function fit(w: number, h: number, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)] as const;
}

const api = {
  /** Decodes once (EXIF orientation applied) and returns a downscaled photo plus a thumbnail. */
  async normalize(file: Blob, maxSide: number, thumbSide: number) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const [w, h] = fit(bmp.width, bmp.height, maxSide);
    const main = await encode(bmp, w, h, 0.9);
    bmp.close();
    const [tw, th] = fit(w, h, thumbSide);
    const thumb = await encode(main.canvas, tw, th, 0.8);
    return { blob: main.blob, thumb: thumb.blob, width: w, height: h };
  },
  crop: cropImage,
  async sticker(crop: Blob, alpha: Uint8Array, w: number, h: number) {
    return makeSticker(crop, alpha, w, h);
  },
};

export type ImageApi = typeof api;
Comlink.expose(api);
