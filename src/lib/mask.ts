import type { Box } from '../db';

/**
 * Zeroes every part of a soft alpha mask that isn't connected to the face box.
 * Removes stray blobs (other people, objects) that the matting model kept.
 */
export function keepComponentsTouching(alpha: Uint8Array, w: number, h: number, face: Box, threshold = 128): Uint8Array {
  const labels = new Int32Array(w * h);
  const keep = new Set<number>();
  const fx1 = Math.max(0, Math.floor(face[0])), fy1 = Math.max(0, Math.floor(face[1]));
  const fx2 = Math.min(w - 1, Math.ceil(face[2])), fy2 = Math.min(h - 1, Math.ceil(face[3]));
  const stack = new Int32Array(w * h);
  let next = 1;

  for (let start = 0; start < w * h; start++) {
    if (labels[start] || alpha[start] < threshold) continue;
    const label = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let touches = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      if (x >= fx1 && x <= fx2 && y >= fy1 && y <= fy2) touches = true;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (touches) keep.add(label);

    function push(j: number) {
      if (!labels[j] && alpha[j] >= threshold) {
        labels[j] = label;
        stack[sp++] = j;
      }
    }
  }

  if (keep.size === 0) return alpha; // nothing touched the face; don't wipe the sticker

  // Keep soft edge pixels that sit next to a kept component.
  const out = new Uint8Array(w * h);
  const r = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i] === 0) continue;
      if (labels[i] && keep.has(labels[i])) {
        out[i] = alpha[i];
        continue;
      }
      if (labels[i]) continue; // solid pixel of a dropped component
      let near = false;
      for (let dy = -r; dy <= r && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const l = labels[yy * w + xx];
          if (l && keep.has(l)) {
            near = true;
            break;
          }
        }
      }
      if (near) out[i] = alpha[i];
    }
  }
  return out;
}

/**
 * Makes see-through gaps that are fully enclosed by the mask solid (e.g. a
 * patchy hood or a gap between hair and ear), so the sticker has no holes.
 * Edits alpha in place.
 */
export function fillHoles(alpha: Uint8Array, w: number, h: number, threshold = 128) {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!outside[i] && alpha[i] < threshold) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!outside[i] && alpha[i] < threshold) alpha[i] = 255;
}

/** 1 inside an ellipse around the face, fading to 0 between inner and 1 (radius fractions). */
function ellipseWeight(face: Box, rxF: number, ryF: number, inner = 0.85) {
  const fw = face[2] - face[0], fh = face[3] - face[1];
  const cx = (face[0] + face[2]) / 2;
  const cy = (face[1] + face[3]) / 2 - fh * 0.15; // heads extend further up than down
  const rx = fw * rxF, ry = fh * ryF;
  return (x: number, y: number) => {
    const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
    if (r <= inner) return 1;
    if (r >= 1) return 0;
    const t = (r - inner) / (1 - inner);
    return 1 - t * t * (3 - 2 * t);
  };
}

/**
 * Fallback when face parsing is unavailable: fades the alpha out beyond a
 * head-shaped ellipse around the face. Edits alpha in place.
 */
export function trimToHead(alpha: Uint8Array, w: number, h: number, face: Box) {
  const weight = ellipseWeight(face, 0.95, 1.08, 0.9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) alpha[y * w + x] *= weight(x, y);
  }
}

// Face-parsing classes (CelebAMask-HQ) that make up a head sticker: skin, nose,
// glasses, eyes, brows, ears, mouth, lips, hair, hat, earrings. Neck, necklace
// and clothes are left out, so the sticker ends under the chin.
const HEAD_CLASSES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const HAIR = 13, HAT = 14;

/**
 * Soft head mask (0..255, w*h) from a face-parsing label map (lw*lh, covering
 * the same crop). Hair and hats must stay near the face: dark backgrounds are
 * often labelled as hair.
 */
export function headMask(labels: Uint8Array, lw: number, lh: number, w: number, h: number, face: Box): Uint8Array {
  const hairNear = ellipseWeight(face, 1.15, 1.2);
  const hatNear = ellipseWeight(face, 1.7, 1.7);
  const small = new OffscreenCanvas(lw, lh);
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(lw, lh);
  const sx = w / lw, sy = h / lh;
  for (let i = 0; i < lw * lh; i++) {
    const c = labels[i];
    if (!HEAD_CLASSES.has(c)) continue;
    const x = ((i % lw) + 0.5) * sx, y = (((i / lw) | 0) + 0.5) * sy;
    const wgt = c === HAIR ? hairNear(x, y) : c === HAT ? hatNear(x, y) : 1;
    img.data[i * 4 + 3] = Math.round(255 * wgt);
  }
  sctx.putImageData(img, 0, 0);

  // Upscale smoothly, then firm up the edge so it isn't blurry.
  const big = new OffscreenCanvas(w, h);
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingQuality = 'high';
  bctx.filter = `blur(${Math.max(1, sx / 2)}px)`;
  bctx.drawImage(small, 0, 0, w, h);
  const d = bctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3];
    out[i] = a < 90 ? 0 : a > 165 ? 255 : Math.round(((a - 90) / 75) * 255);
  }
  return out;
}
