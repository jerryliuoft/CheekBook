import type { Box } from '../db';

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Greedy non-maximum suppression. Returns kept indices, highest score first. */
export function nms(boxes: Box[], scores: number[], threshold: number): number[] {
  const order = scores.map((_, i) => i).sort((i, j) => scores[j] - scores[i]);
  const keep: number[] = [];
  const removed = new Uint8Array(boxes.length);
  for (const i of order) {
    if (removed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (!removed[j] && j !== i && iou(boxes[i], boxes[j]) > threshold) removed[j] = 1;
    }
  }
  return keep;
}

/**
 * Least-squares 2D similarity transform (rotation + uniform scale + translation)
 * mapping src points onto dst points. Returns [p, q, tx, ty] where
 * x' = p*x - q*y + tx,  y' = q*x + p*y + ty.
 */
export function similarityTransform(src: number[][], dst: number[][]): [number, number, number, number] {
  const n = src.length;
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i][0]; my += src[i][1]; mu += dst[i][0]; mv += dst[i][1];
  }
  mx /= n; my /= n; mu /= n; mv /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - mx, ys = src[i][1] - my;
    const us = dst[i][0] - mu, vs = dst[i][1] - mv;
    num1 += xs * us + ys * vs;
    num2 += xs * vs - ys * us;
    den += xs * xs + ys * ys;
  }
  const p = num1 / den;
  const q = num2 / den;
  return [p, q, mu - (p * mx - q * my), mv - (q * mx + p * my)];
}

export function clampBox(b: Box, w: number, h: number): Box {
  return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])];
}

export function boxArea(b: Box): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function unionBox(boxes: Box[]): Box {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}
