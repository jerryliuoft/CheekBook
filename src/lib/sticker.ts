// Turns a cut-out (image + alpha) into a die-cut sticker:
// trimmed, thick border, soft drop shadow, a little extra colour.

const MAX_SIDE = 768;

/** Colours from the theme (read on the main thread; workers can't see CSS). */
export interface StickerColors {
  edge: string;
  shadow: string;
}

/** Bounds of the opaque part of an image. */
function opaqueBounds(img: ImageData) {
  const { width: w, height: h, data } = img;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 40) {
      const x = i % w, y = (i / w) | 0;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return { x1, y1, x2, y2 };
}

/**
 * turn: radians to rotate the cut-out by before the border goes on, so a
 * head lying sideways or upside down ends up right side up on the sticker.
 */
export async function makeSticker(crop: Blob, alpha: Uint8Array, w: number, h: number, colors: StickerColors, turn = 0) {
  // 1. Cut-out with alpha applied, slightly warmer and brighter.
  const bmp = await createImageBitmap(crop);
  let base = new OffscreenCanvas(w, h);
  const bctx = base.getContext('2d', { willReadFrequently: true })!;
  bctx.filter = 'saturate(1.12) brightness(1.04) contrast(1.02)';
  bctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = bctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = alpha[i] < 16 ? 0 : alpha[i]; // drop faint haze
  bctx.putImageData(img, 0, 0);

  if (turn) {
    // Rotate about the centre onto a canvas big enough for any angle.
    const cos = Math.abs(Math.cos(turn)), sin = Math.abs(Math.sin(turn));
    const rw = Math.ceil(w * cos + h * sin), rh = Math.ceil(w * sin + h * cos);
    const rot = new OffscreenCanvas(rw, rh);
    const rctx = rot.getContext('2d', { willReadFrequently: true })!;
    rctx.imageSmoothingQuality = 'high';
    rctx.translate(rw / 2, rh / 2);
    rctx.rotate(turn);
    rctx.drawImage(base, -w / 2, -h / 2);
    base = rot;
  }
  const { x1, y1, x2, y2 } = opaqueBounds(base.getContext('2d')!.getImageData(0, 0, base.width, base.height));
  if (x2 < 0) throw new Error('Cut-out came back empty');

  // 2. Trim and scale to output size.
  const tw = x2 - x1 + 1, th = y2 - y1 + 1;
  const scale = Math.min(1, MAX_SIDE / Math.max(tw, th));
  const cw = Math.round(tw * scale), ch = Math.round(th * scale);
  const border = Math.round(Math.max(8, Math.min(36, Math.max(cw, ch) * 0.045)));
  const shadow = Math.round(border * 1.1);
  const pad = border + shadow * 2;
  const W = cw + pad * 2, H = ch + pad * 2;

  const cut = new OffscreenCanvas(W, H);
  const cctx = cut.getContext('2d')!;
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(base, x1, y1, tw, th, pad, pad, cw, ch);

  // 3. Silhouette in the edge colour, stamped in a ring to grow it into a rounded border.
  const sil = new OffscreenCanvas(W, H);
  const sctx = sil.getContext('2d')!;
  sctx.drawImage(cut, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = colors.edge;
  sctx.fillRect(0, 0, W, H);

  const outline = new OffscreenCanvas(W, H);
  const octx = outline.getContext('2d')!;
  const steps = 40;
  for (const r of [border, border * 0.66, border * 0.33]) {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      octx.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  octx.drawImage(sil, 0, 0);
  // Blur, then cut at the middle: rounds off small bumps and notches so the
  // border reads as one clean die-cut curve, the way a real sticker is cut.
  const smooth = new OffscreenCanvas(W, H);
  const mctx = smooth.getContext('2d', { willReadFrequently: true })!;
  mctx.filter = `blur(${Math.max(2, border * 0.4)}px)`;
  mctx.drawImage(outline, 0, 0);
  const od = mctx.getImageData(0, 0, W, H);
  for (let i = 3; i < od.data.length; i += 4) {
    const a = od.data[i];
    od.data[i] = a < 100 ? 0 : a > 150 ? 255 : Math.round(((a - 100) / 50) * 255);
  }
  mctx.putImageData(od, 0, 0);

  // 4. Compose: shadowed border, then the photo on top.
  const out = new OffscreenCanvas(W, H);
  const ctx = out.getContext('2d')!;
  ctx.shadowColor = colors.shadow;
  ctx.shadowBlur = shadow;
  ctx.shadowOffsetY = Math.round(shadow * 0.35);
  ctx.drawImage(smooth, 0, 0);
  ctx.shadowColor = 'transparent';
  ctx.drawImage(cut, 0, 0);

  return { blob: await out.convertToBlob({ type: 'image/png' }), width: W, height: H };
}
