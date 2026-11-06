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
 * Makes everything inside the sticker's outline fully opaque, leaving only a
 * soft outer rim of `rim` px. Fills enclosed gaps (a patchy hood, a gap by the
 * ear) together with their faded edges, which would otherwise let the white
 * sticker border show through as thin lines. Edits alpha in place.
 */
export function solidify(alpha: Uint8Array, w: number, h: number, rim: number, threshold = 128) {
  // 1. Everything not reachable from the border through clear pixels is inside.
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
  // 2. Shrink the inside by the rim width (separable erosion), then make it solid.
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = outside[i] ? 0 : 1;
  const core = erode(erode(inside, w, h, rim, 1, w), w, h, rim, w, 1);
  for (let i = 0; i < w * h; i++) if (core[i]) alpha[i] = 255;
}

/** Binary erosion along one axis: step is the index distance between neighbours. */
function erode(src: Uint8Array, w: number, h: number, r: number, step: number, lineStep: number) {
  const out = new Uint8Array(w * h);
  const lines = step === 1 ? h : w, len = step === 1 ? w : h;
  const ones = new Int32Array(len + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let k = 0; k < len; k++) ones[k + 1] = ones[k] + src[base + k * step];
    for (let k = 0; k < len; k++) {
      const a = k - r, b = k + r;
      if (a < 0 || b >= len) continue; // the window runs off the image: not inside
      if (ones[b + 1] - ones[a] === 2 * r + 1) out[base + k * step] = 1;
    }
  }
  return out;
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
const HEAD_CLASSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const HAIR = 13, HAT = 14;

export interface ParseResult {
  logits: Float32Array; // [classes, lh, lw]
  classes: number;
  lw: number;
  lh: number;
}

export interface Guide {
  data: Uint8ClampedArray | Uint8Array; // the crop's pixels
  channels: number;
}

/**
 * Soft head mask (0..255, w*h) for a crop, from face parsing.
 *
 * The crop has been turned so the face is upright. Hair and hats
 * must stay near the face, since dark backgrounds are often labelled as hair.
 * The parse map is coarse (1/4 of 256 px), so the head probability is
 * upsampled smoothly and its edge is snapped to the photo with a guided filter.
 * The parser sometimes misses a baby's face (a scrunched-up cry, a second face
 * next to it), so the face found by detection is always kept.
 */
export function headMask(p: ParseResult, w: number, h: number, face: Box, guide: Guide): Uint8Array {
  const { logits, classes, lw, lh } = p;
  const hairNear = ellipseWeight(face, 1.15, 1.2);
  const hatNear = ellipseWeight(face, 1.7, 1.7);
  const plane = lw * lh;
  const sx = w / lw, sy = h / lh;
  const small = new OffscreenCanvas(lw, lh);
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(lw, lh);
  for (let i = 0; i < plane; i++) {
    let max = -Infinity;
    for (let c = 0; c < classes; c++) max = Math.max(max, logits[c * plane + i]);
    let sum = 0;
    for (let c = 0; c < classes; c++) sum += Math.exp(logits[c * plane + i] - max);
    const x = ((i % lw) + 0.5) * sx, y = (((i / lw) | 0) + 0.5) * sy;
    let head = 0;
    for (const c of HEAD_CLASSES) {
      const pc = Math.exp(logits[c * plane + i] - max) / sum;
      head += c === HAIR ? pc * hairNear(x, y) : c === HAT ? pc * hatNear(x, y) : pc;
    }
    img.data[i * 4 + 3] = Math.round(255 * Math.min(1, head));
  }
  sctx.putImageData(img, 0, 0);

  // Upscale smoothly to the crop's size.
  const big = new OffscreenCanvas(w, h);
  const bctx = big.getContext('2d', { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  const d = bctx.getImageData(0, 0, w, h).data;
  const prob = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) prob[i] = d[i * 4 + 3] / 255;

  // Snap the edge to the photo's own edges (chin, hairline), then firm it up.
  const gray = new Float32Array(w * h);
  const ch = guide.channels;
  for (let i = 0; i < w * h; i++) {
    const j = i * ch;
    gray[i] = (0.299 * guide.data[j] + 0.587 * guide.data[j + 1] + 0.114 * guide.data[j + 2]) / 255;
  }
  const snapped = guidedFilter(gray, prob, w, h, Math.max(4, Math.round(Math.max(w, h) / 90)), 2e-3);
  const core = faceCore(face);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = Math.min(1, Math.max(0, (snapped[i] - 0.4) / 0.2));
      out[i] = Math.round(255 * Math.max(t * t * (3 - 2 * t), core(x, y)));
    }
  }
  // A head outline is rounded: fill bites the parser took out of it.
  const fill = closeShape(out, w, h, Math.round(Math.max(face[2] - face[0], face[3] - face[1]) * 0.15));
  for (let i = 0; i < w * h; i++) out[i] = Math.max(out[i], fill[i]);
  return out;
}

/**
 * Morphological closing with a round brush of radius r (blur, then threshold,
 * twice): fills notches and bays narrower than about 2r, keeps the outline round.
 */
function closeShape(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, lo: number, hi: number) => {
    const a = new OffscreenCanvas(w, h);
    const actx = a.getContext('2d')!;
    const img = actx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = src[i];
    actx.putImageData(img, 0, 0);
    const b = new OffscreenCanvas(w, h);
    const bctx = b.getContext('2d', { willReadFrequently: true })!;
    bctx.filter = `blur(${r / 2}px)`;
    bctx.drawImage(a, 0, 0);
    const d = bctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const t = Math.min(1, Math.max(0, (d[i * 4 + 3] - lo) / (hi - lo)));
      out[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
    return out;
  };
  // Grow (anything the blur reaches), then shrink back (only what stays solid).
  return pass(pass(mask, 10, 60), 195, 245);
}

/** 1 inside the ellipse that fits the detected face box, fading out at its edge. */
function faceCore(face: Box) {
  const cx = (face[0] + face[2]) / 2, cy = (face[1] + face[3]) / 2;
  const rx = ((face[2] - face[0]) / 2) * 0.78, ry = ((face[3] - face[1]) / 2) * 0.78;
  return (x: number, y: number) => {
    const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
    return r <= 0.85 ? 1 : r >= 1 ? 0 : (1 - r) / 0.15;
  };
}

/** Box mean over a (2r+1)^2 window, clipped at the borders (integral image). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r), y2 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r), x2 = Math.min(w, x + r + 1);
      const s = sat[y2 * W + x2] - sat[y1 * W + x2] - sat[y2 * W + x1] + sat[y1 * W + x1];
      out[y * w + x] = s / ((y2 - y1) * (x2 - x1));
    }
  }
  return out;
}

/** Guided filter (He et al.): smooths p while following the edges of the guide I. */
function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number) {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ip[i] = I[i] * p[i];
    II[i] = I[i] * I[i];
  }
  const mI = boxMean(I, w, h, r), mP = boxMean(p, w, h, r);
  const mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIp[i] - mI[i] * mP[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const mA = boxMean(a, w, h, r), mB = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
  return q;
}
