// Reads each face's expression and looking direction with MediaPipe Face
// Landmarker (blendshape scores + 478 landmarks). The models are trained on
// adults; the rules below were checked on baby photos (see README).
import { FaceLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { FACE_MODELS } from '../config';
import type { Box, Expression, Face, Looking } from '../db';
import { visionFiles } from './mediapipe';

export const EXPRESSIONS: Record<Expression, string> = {
  laughing: 'Laughing',
  smiling: 'Smiling',
  surprised: 'Surprised',
  ooh: 'Ooh',
  sleepy: 'Eyes closed',
  crying: 'Crying',
  upset: 'Upset',
  calm: 'Calm',
};

export const LOOKING: Record<Looking, string> = {
  camera: 'At the camera',
  left: 'Looking left',
  right: 'Looking right',
  up: 'Looking up',
  down: 'Looking down',
};

// Bump when the rules change, so faces are read again.
const EXPRESSION_VERSION = 1;

export function hasCurrentExpression(f: Face): boolean {
  return f.expressionVersion === EXPRESSION_VERSION;
}

type Scores = Record<string, number>;
const avg = (s: Scores, a: string) => (s[`${a}Left`] + s[`${a}Right`]) / 2;
const dist = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y);

// Face-mesh landmark indices.
const NOSE = 1, L_CHEEK = 234, R_CHEEK = 454, FOREHEAD = 10, CHIN = 152;
const R_EYE_OUT = 33, L_EYE_OUT = 263, UPPER_LIP = 13, LOWER_LIP = 14;

function expressionOf(s: Scores, l: NormalizedLandmark[]): Expression {
  const smile = avg(s, 'mouthSmile');
  const blink = avg(s, 'eyeBlink');
  const squint = avg(s, 'eyeSquint');
  const browDown = avg(s, 'browDown');
  const browUp = Math.max(s.browInnerUp, avg(s, 'browOuterUp'));
  // jawOpen barely moves on babies; the gap between the lips is more reliable.
  const gap = dist(l[UPPER_LIP], l[LOWER_LIP]) / dist(l[FOREHEAD], l[CHIN]);
  const open = Math.max(s.jawOpen, (gap - 0.05) * 6);

  if (blink > 0.6 && open < 0.3) return 'sleepy';
  if (smile > 0.3 && open > 0.25) return 'laughing';
  if (smile > 0.35) return 'smiling';
  if (open > 0.3 && (blink > 0.4 || squint > 0.4 || browDown > 0.3)) return 'crying';
  if (open > 0.25 && (browUp > 0.3 || avg(s, 'eyeWide') > 0.3)) return 'surprised';
  if (open > 0.3) return 'ooh';
  if (avg(s, 'mouthFrown') > 0.25 || browDown > 0.4) return 'upset';
  return 'calm';
}

/** Where the face points, as seen in the photo (head turn plus eye direction). */
function lookingOf(s: Scores, l: NormalizedLandmark[]): Looking {
  const headH = ((l[NOSE].x - l[L_CHEEK].x) / (l[R_CHEEK].x - l[L_CHEEK].x) - 0.5) * 2;
  const eyeY = (l[R_EYE_OUT].y + l[L_EYE_OUT].y) / 2;
  const headV = -((l[NOSE].y - eyeY) / (l[CHIN].y - l[FOREHEAD].y) - 0.2) * 4;
  // The subject's left eye looking "out" means looking toward the photo's right.
  const gazeH = (s.eyeLookOutLeft + s.eyeLookInRight - s.eyeLookInLeft - s.eyeLookOutRight) / 2;
  const gazeV = avg(s, 'eyeLookUp') - avg(s, 'eyeLookDown');
  const eyes = avg(s, 'eyeBlink') > 0.45 ? 0 : 0.6; // closed eyes point nowhere
  const h = headH + gazeH * eyes, v = headV + gazeV * eyes;
  if (Math.max(Math.abs(h), Math.abs(v)) < 0.3) return 'camera';
  if (Math.abs(h) >= Math.abs(v)) return h > 0 ? 'right' : 'left';
  return v > 0 ? 'up' : 'down';
}

let landmarker: Promise<FaceLandmarker> | null = null;

function get() {
  landmarker ??= visionFiles().then((vision) =>
    FaceLandmarker.createFromOptions(vision, {
      // CPU: the GPU delegate gives wrong results on some machines, and this is ~30 ms a face.
      baseOptions: { modelAssetPath: FACE_MODELS.faceMesh, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      minFaceDetectionConfidence: 0.2,
      minFacePresenceConfidence: 0.2,
      outputFaceBlendshapes: true,
    }),
  );
  return landmarker;
}

const READ_SIDE = 320;

/** Reads each face box in the photo; null where no face mesh was found. */
export async function readFaces(photo: Blob, boxes: Box[]) {
  const lm = await get();
  const bmp = await createImageBitmap(photo);
  const canvas = new OffscreenCanvas(READ_SIDE, READ_SIDE);
  const ctx = canvas.getContext('2d')!;
  try {
    return boxes.map((b) => {
      // Square crop around the face with some margin, so the mesh model finds it.
      const side = Math.max(b[2] - b[0], b[3] - b[1]) * 1.8;
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      ctx.fillStyle = '#000'; // theme-ok: model input, not UI
      ctx.fillRect(0, 0, READ_SIDE, READ_SIDE);
      ctx.drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, READ_SIDE, READ_SIDE);
      const res = lm.detect(canvas);
      const l = res.faceLandmarks[0];
      if (!l) return null;
      const s: Scores = {};
      for (const c of res.faceBlendshapes[0].categories) s[c.categoryName] = c.score;
      return { expression: expressionOf(s, l), looking: lookingOf(s, l) };
    });
  } finally {
    bmp.close();
  }
}

/** Fields to store on the face (expression left empty if no mesh was found). */
export function expressionFields(r: Awaited<ReturnType<typeof readFaces>>[number]): Partial<Face> {
  return { expression: r?.expression, looking: r?.looking, expressionVersion: EXPRESSION_VERSION };
}
