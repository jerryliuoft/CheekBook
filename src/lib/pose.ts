import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { FACE_MODELS } from '../config';

/** One person's 33 landmarks in image pixels; v is visibility (0..1). */
export type Pose = { x: number; y: number; v: number }[];

let landmarker: Promise<PoseLandmarker> | null = null;

function get(): Promise<PoseLandmarker> {
  if (!landmarker) {
    landmarker = (async () => {
      const vision = await FilesetResolver.forVisionTasks(FACE_MODELS.mediapipeWasm);
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: FACE_MODELS.pose, delegate },
        runningMode: 'IMAGE' as const,
        numPoses: 4,
        minPoseDetectionConfidence: 0.35,
        minPosePresenceConfidence: 0.35,
      });
      try {
        return await PoseLandmarker.createFromOptions(vision, opts('GPU'));
      } catch {
        return PoseLandmarker.createFromOptions(vision, opts('CPU'));
      }
    })();
  }
  return landmarker;
}

/** Returns poses as landmark lists in pixel coordinates of the given image. */
export async function detectPoses(blob: Blob): Promise<Pose[]> {
  const lm = await get();
  const bmp = await createImageBitmap(blob);
  const res = lm.detect(bmp);
  const { width, height } = bmp;
  bmp.close();
  return res.landmarks.map((pose: NormalizedLandmark[]) =>
    pose.map((p) => ({ x: p.x * width, y: p.y * height, v: p.visibility ?? 0 })),
  );
}
