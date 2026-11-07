const W = 128, H = 64;

/**
 * How sharp a face is (about 0..1), from the band around the eyes: the steepest
 * edges there relative to its contrast. Baby skin is smooth even when sharp,
 * so the eyes (lashes, lids, iris) are the reliable place to look. A small face
 * is scaled up to 128 px and scores low too, which is what we want: both make a
 * soft face sticker. kps: the face's 5 landmarks (eyes first).
 */
export function faceSharpness(photo: ImageBitmap, kps: number[]): number {
  const [lx, ly, rx, ry] = kps;
  const eyes = Math.hypot(rx - lx, ry - ly);
  const cx = (lx + rx) / 2, cy = (ly + ry) / 2;
  const bw = eyes * 1.8, bh = eyes * 0.9;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(photo, cx - bw / 2, cy - bh / 2, bw, bh, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

  const grads: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      grads.push(Math.hypot(g[i + 1] - g[i - 1], g[i + W] - g[i - W]) / 2);
    }
  }
  const sortedG = grads.sort((a, b) => a - b);
  const sortedV = Array.from(g).sort((a, b) => a - b);
  const range = Math.max(16, sortedV[Math.floor(sortedV.length * 0.98)] - sortedV[Math.floor(sortedV.length * 0.02)]);
  return sortedG[Math.floor(sortedG.length * 0.99)] / range;
}
