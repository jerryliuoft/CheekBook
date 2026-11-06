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
 * Fades the alpha out beyond a head-shaped ellipse around the face (hair, ears
 * and chin included), so a face sticker doesn't carry along whoever is holding
 * the baby. Edits alpha in place.
 */
export function trimToHead(alpha: Uint8Array, w: number, h: number, face: Box) {
  const fw = face[2] - face[0], fh = face[3] - face[1];
  const cx = (face[0] + face[2]) / 2;
  const cy = (face[1] + face[3]) / 2 - fh * 0.12;
  const rx = fw * 0.95, ry = fh * 1.08;
  const inner = 0.9; // start fading at 90% of the radius
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / ry;
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r <= inner) continue;
      const i = y * w + x;
      if (r >= 1) alpha[i] = 0;
      else {
        const t = (r - inner) / (1 - inner);
        alpha[i] = Math.round(alpha[i] * (1 - t * t * (3 - 2 * t)));
      }
    }
  }
}
