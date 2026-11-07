// Finds things a baby holds or chews (bottle, cup, teddy bear, ball...) so
// stickers keep them instead of cutting a hole where they cover the face.
// MediaPipe EfficientDet-Lite2 (COCO classes) finds them; MagicTouch outlines
// each one. Both run on the CPU like the other MediaPipe models.
import { InteractiveSegmenterLegacy, ObjectDetector } from '@mediapipe/tasks-vision';
import { FACE_MODELS } from '../config';
import type { Box, HeldObject } from '../db';
import { visionFiles } from './mediapipe';

// COCO classes small enough to be held, and likely around a baby.
const HOLDABLE = new Set([
  'bottle', 'cup', 'wine glass', 'teddy bear', 'sports ball', 'book', 'spoon', 'fork', 'banana', 'apple',
  'orange', 'carrot', 'donut', 'toothbrush', 'cell phone', 'remote', 'frisbee', 'kite', 'scissors', 'mouse',
]);

let detector: Promise<ObjectDetector> | null = null;
let segmenter: Promise<InteractiveSegmenterLegacy> | null = null;

const getDetector = () =>
  (detector ??= visionFiles().then((vision) =>
    ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODELS.objects, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: 0.3,
      maxResults: 20,
    }),
  ));

const getSegmenter = () =>
  (segmenter ??= visionFiles().then((vision) =>
    InteractiveSegmenterLegacy.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODELS.magicTouch, delegate: 'CPU' },
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    }),
  ));

/** Holdable objects in the photo, boxes in its pixels. */
export async function detectObjects(photo: Blob): Promise<HeldObject[]> {
  const det = await getDetector();
  const bmp = await createImageBitmap(photo);
  try {
    const out: HeldObject[] = [];
    for (const d of det.detect(bmp).detections) {
      const c = d.categories[0];
      const b = d.boundingBox;
      if (!b || !c || !HOLDABLE.has(c.categoryName)) continue;
      out.push({
        label: c.categoryName,
        score: c.score,
        box: [b.originX, b.originY, b.originX + b.width, b.originY + b.height],
      });
    }
    return out;
  } finally {
    bmp.close();
  }
}

/**
 * Outlines each object (boxes in the image's pixels) and returns one w*h soft
 * mask (0..255). Each outline is kept to its box, so a stray grab of the baby or
 * the background can't spread.
 */
export async function segmentObjects(image: Blob, boxes: Box[]): Promise<Uint8Array | null> {
  if (!boxes.length) return null;
  const seg = await getSegmenter();
  const bmp = await createImageBitmap(image);
  const { width: w, height: h } = bmp;
  const out = new Uint8Array(w * h);
  try {
    for (const b of boxes) {
      // A short scribble down the middle of the box, rather than one point that
      // may land on the hand holding it.
      const cx = (b[0] + b[2]) / 2 / w;
      const scribble = [0.3, 0.5, 0.7].map((t) => ({ x: cx, y: (b[1] + (b[3] - b[1]) * t) / h }));
      let mask: Float32Array | null = null, mw = 0, mh = 0;
      seg.segment(bmp, { scribble }, (r) => {
        const m = r.confidenceMasks?.[0];
        if (!m) return;
        mask = m.getAsFloat32Array().slice(); // the result is only valid inside the callback
        mw = m.width;
        mh = m.height;
        r.confidenceMasks!.forEach((c) => c.close());
      });
      if (!mask) continue;
      const m = mask as Float32Array;
      const pad = 0.08 * Math.max(b[2] - b[0], b[3] - b[1]);
      const x0 = Math.max(0, Math.floor(b[0] - pad)), x1 = Math.min(w, Math.ceil(b[2] + pad));
      const y0 = Math.max(0, Math.floor(b[1] - pad)), y1 = Math.min(h, Math.ceil(b[3] + pad));
      const at = (x: number, y: number) => m[Math.min(mh - 1, Math.floor((y * mh) / h)) * mw + Math.min(mw - 1, Math.floor((x * mw) / w))];
      // A real object's outline sits mostly inside its box (the hand holding it
      // may spill out a little) and fills a good part of it. One that spreads
      // far beyond has grabbed the whole baby or the background (the detector
      // also boxes the odd cheek or ear): skip it. On our photos real objects
      // kept 53-100% of their outline in the box, a cheek false hit 2%.
      let total = 0, inBox = 0;
      for (let i = 0; i < m.length; i++) if (m[i] > 0.5) total++;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (at(x, y) > 0.5) inBox++;
      const scale = (mw * mh) / (w * h); // inBox counts image pixels, total counts mask pixels
      const boxArea = (b[2] - b[0]) * (b[3] - b[1]);
      if (!total || (inBox * scale) / total < 0.4 || inBox < boxArea * 0.2) continue;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = Math.round(at(x, y) * 255);
          if (v > out[y * w + x]) out[y * w + x] = v;
        }
      }
    }
  } finally {
    bmp.close();
  }
  return out;
}
