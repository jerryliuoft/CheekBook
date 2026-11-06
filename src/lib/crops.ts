import type { Box, CropKind, CropOption } from '../db';
import { boxArea, clampBox, unionBox } from './geometry';

type Pose = { x: number; y: number; v: number }[];

// MediaPipe pose landmark indices
const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;
const L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const VISIBLE = 0.5;

// Smallest crop side (stored-photo pixels) that still makes a sharp sticker.
export const MIN_SIDE: Record<CropKind, number> = { face: 96, upper: 220, full: 300 };
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

function option(kind: CropKind, rect: Box, w: number, h: number, bodyBox: Box, missing?: string, face?: Box): CropOption {
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
  return { kind, rect: clipped, available: !reason, reason, bodyBox: clampBox(bodyBox, w, h) };
}

/** Works out face / upper-body / full-body crops for one face. */
export function computeCrops(face: Box, w: number, h: number, poses: Pose[]): CropOption[] {
  const fw = face[2] - face[0], fh = face[3] - face[1];
  const cx = (face[0] + face[2]) / 2;
  const pose = matchPose(face, poses);
  const vis = (i: number) => !!pose && pose[i].v >= VISIBLE;
  const pt = (i: number): Box => [pose![i].x, pose![i].y, pose![i].x, pose![i].y];

  // Face: square around the face, shifted up for hair, generous so ears/cheeks fit.
  const fs = Math.max(fw, fh) * 1.9;
  const fcy = (face[1] + face[3]) / 2 - fh * 0.08;
  const faceRect: Box = [cx - fs / 2, fcy - fs / 2, cx + fs / 2, fcy + fs / 2];
  const crops: CropOption[] = [option('face', faceRect, w, h, faceRect)];

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
  crops.push(option('upper', upper, w, h, upper, undefined, face));

  // Full body: needs knees or ankles from the pose.
  if (pose && (vis(L_ANKLE) || vis(R_ANKLE) || vis(L_KNEE) || vis(R_KNEE))) {
    const pts = pose.filter((p) => p.v >= VISIBLE).map((p): Box => [p.x, p.y, p.x, p.y]);
    const full = expand(unionBox([expand(face, 0.25, 0.45), ...pts]), 0.12, 0.06);
    crops.push(option('full', full, w, h, full));
  } else {
    crops.push(option('full', faceRect, w, h, faceRect, 'Legs not visible'));
  }
  return crops;
}
