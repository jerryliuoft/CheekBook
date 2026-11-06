import { FilesetResolver } from '@mediapipe/tasks-vision';
import { FACE_MODELS } from '../config';

let files: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

/** MediaPipe's wasm runtime, served from public/mediapipe and shared by all tasks. */
export function visionFiles() {
  files ??= FilesetResolver.forVisionTasks(FACE_MODELS.mediapipeWasm);
  return files;
}
