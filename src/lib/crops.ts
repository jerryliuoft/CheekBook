import type { Box, CropKind, CropOption, Face, HeldObject } from '../db';
import { boxArea, clampBox, unionBox } from './geometry';
import type { Pose } from './pose';

// MediaPipe pose landmark indices
const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;
const L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const VISIBLE = 0.5;

// Bump when the crop rules change, so cached crops are recomputed.
const CROPS_VERSION = 5;

export function hasCurrentCrops(f: Face): boolean {
  return !!f.crops && f.cropsVersion === CROPS_VERSION;
}

// Smallest crop side (stored-photo pixels) that still makes a sharp sticker.
const MIN_SIDE: Record<CropKind, number> = { face: 96, upper: 220, full: 300 };
// How much of a crop may fall outside the photo before we stop offering it.
const MAX_OUTSIDE = 0.25;

function expand(b: Box, fx: number, fy = fx): Box {
  const w = b[2] - b[0], h = b[3] - b[1];
  return [b[0] - w * fx, b[1] - h * fy, b[2] + w * fx, b[3] + h * fy];
}

/** Picks the pose whose nose (or head) lands inside the face box. */
function matchPose(face: Box, poses: Pose[]): Pose | null {
  const zone = expand(face, 0.35);
  for (const p of poses) {
    const n = p[NOSE];
    if (n.x >= zone[0] && n.x <= zone[2] && n.y >= zone[1] && n.y <= zone[3]) return p;
  }
  return null;
}

function option(kind: CropKind, rect: Box, w: number, h: number, missing?: string, face?: Box): CropOption {
  const clipped = clampBox(rect, w, h);
  const cw = clipped[2] - clipped[0], ch = clipped[3] - clipped[1];
  let reason = missing;
  if (!reason && kind === 'upper' && face) {
    // The photo edge may trim it, but it must still show clearly more than the face.
    const fw = face[2] - face[0], fh = face[3] - face[1];
    if (clipped[3] - face[1] < fh * 1.9 || cw < fw * 1.6) reason = 'Not enough body in the photo';
  }
  if (!reason && kind === 'full') {
    const inside = boxArea(clipped) / Math.max(1, boxArea(rect));
    if (1 - inside > MAX_OUTSIDE) reason = 'Cut off by the photo edge';
  }
  if (!reason && Math.min(cw, ch) < MIN_SIDE[kind]) reason = `Too small (${Math.round(Math.min(cw, ch))}px)`;
  return { kind, rect: clipped, available: !reason, reason };
}

// A face sticker needs a face at least this big (stored-photo pixels) and this
// sharp (see sharpness.ts); otherwise a body crop makes the better sticker.
const FACE_MIN_PX = 120;
const FACE_MIN_SHARPNESS = 0.09; // clearly blurry faces scored 0.07-0.088 on our photos

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** Share of box a that lies inside box b. */
const inside = (a: Box, b: Box) => overlap(a, b) / Math.max(1, boxArea(a));

/** Grows a crop rect to take in the held objects, with a little margin. */
function takeIn(rect: Box, objects: HeldObject[]): Box {
  if (!objects.length) return rect;
  return unionBox([rect, ...objects.map((o) => expand(o.box, 0.06))]);
}

/**
 * Works out face / upper-body / full-body crops for one face, which things the
 * person holds, and which crop makes the best sticker.
 */
export function computeCrops(
  face: Box,
  w: number,
  h: number,
  poses: Pose[],
  objects: HeldObject[] = [],
  sharpness = 1,
): Pick<Face, 'crops' | 'cropsVersion' | 'held' | 'best' | 'sharpness'> {
  const fw = face[2] - face[0], fh = face[3] - face[1];
  const size = Math.max(fw, fh);
  // Hand-sized things that aren't the face itself (the detector sometimes boxes a face).
  const candidates = objects.filter(
    (o) => inside(o.box, face) < 0.5 && Math.max(o.box[2] - o.box[0], o.box[3] - o.box[1]) < size * 2.5,
  );
  // Touching the face: a bottle at the mouth, a toy against the cheek.
  const faceZone = expand(face, 0.12);
  const atFace = candidates.filter((o) => overlap(o.box, faceZone) > 0).map((o) => ({ ...o, nearFace: true }));
  const cx = (face[0] + face[2]) / 2;
  const pose = matchPose(face, poses);
  const vis = (i: number) => !!pose && pose[i].v >= VISIBLE;
  const pt = (i: number): Box => [pose![i].x, pose![i].y, pose![i].x, pose![i].y];

  // Face: square around the face, shifted up and roomy enough for hair, ears and
  // hats (a baby's head is large next to its face). Face parsing trims it later.
  const fs = Math.max(fw, fh) * 2.2;
  const fcy = (face[1] + face[3]) / 2 - fh * 0.12;
  const faceRect = takeIn([cx - fs / 2, fcy - fs / 2, cx + fs / 2, fcy + fs / 2], atFace);
  const crops: CropOption[] = [option('face', faceRect, w, h)];

  // Upper body: head to hips. Uses pose when we have shoulders, otherwise face proportions.
  let upper: Box;
  if (vis(L_SHOULDER) && vis(R_SHOULDER)) {
    const parts = [expand(face, 0.25, 0.45), pt(L_SHOULDER), pt(R_SHOULDER)];
    if (vis(L_HIP)) parts.push(pt(L_HIP));
    if (vis(R_HIP)) parts.push(pt(R_HIP));
    let u = unionBox(parts);
    if (!vis(L_HIP) && !vis(R_HIP)) u = [u[0], u[1], u[2], Math.max(u[3], face[3] + fh * 2.2)];
    upper = expand(u, 0.12, 0.06);
  } else {
    upper = [cx - fw * 1.7, face[1] - fh * 0.45, cx + fw * 1.7, face[3] + fh * 2.4];
  }
  // Things held in the hands, in front of the body.
  const atFaceBoxes = new Set(atFace.map((o) => o.box));
  const inHands = candidates.filter((o) => {
    if (atFaceBoxes.has(o.box)) return false;
    const c: Box = [(o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2, 0, 0];
    return c[0] > upper[0] && c[0] < upper[2] && c[1] > upper[1] && c[1] < upper[3];
  });
  const held = [...atFace, ...inHands];
  upper = takeIn(upper, held);
  crops.push(option('upper', upper, w, h, undefined, face));

  // Full body: needs knees or ankles from the pose.
  if (pose && (vis(L_ANKLE) || vis(R_ANKLE) || vis(L_KNEE) || vis(R_KNEE))) {
    const pts = pose.filter((p) => p.v >= VISIBLE).map((p): Box => [p.x, p.y, p.x, p.y]);
    const full = takeIn(expand(unionBox([expand(face, 0.25, 0.45), ...pts]), 0.12, 0.06), held);
    crops.push(option('full', full, w, h));
  } else {
    crops.push(option('full', faceRect, w, h, 'Legs not visible'));
  }
  return { crops, cropsVersion: CROPS_VERSION, held, sharpness, best: bestKind(crops, size, sharpness, inHands.length > 0) };
}

/**
 * Face sticker when the face is big and sharp; otherwise (or when the baby holds
 * something away from the face) the upper or full body, so the sticker isn't a
 * blurry face or a face missing its toy. Null when nothing makes a good sticker.
 */
function bestKind(crops: CropOption[], size: number, sharpness: number, holding: boolean): CropKind | null {
  const ok = (k: CropKind) => crops.find((c) => c.kind === k)?.available;
  const goodFace = ok('face') && size >= FACE_MIN_PX && sharpness >= FACE_MIN_SHARPNESS;
  if (goodFace && !(holding && ok('upper'))) return 'face';
  if (ok('upper')) return 'upper';
  if (ok('full')) return 'full';
  return ok('face') ? 'face' : null;
}

/** Held objects to keep in a sticker made from this crop. */
export function heldIn(face: Face, kind: CropKind, rect: Box): Box[] {
  return (face.held ?? []).filter((o) => (kind !== 'face' || o.nearFace) && inside(o.box, rect) > 0.6).map((o) => o.box);
}
