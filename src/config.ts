// Central place for model choices and tunable thresholds.

// Person cut-out (matting) model, run on the CPU via Transformers.js. Downloaded
// from the Hugging Face Hub on first use. GPU cut-outs and SAM were tried and
// dropped: see "Notes and known limits" in the README.
export const CUTOUT_MODEL = 'Xenova/modnet';
// Face parsing (SegFormer, CelebAMask-HQ classes) shapes face stickers to the
// real head: hair, ears and chin in; towels, hands and backgrounds out. 256 px
// input looks as good as 512 px at a quarter of the time.
export const PARSER_MODEL = 'jonathandinu/face-parsing';
export const PARSE_SIZE = 256;

export const FACE_MODELS = {
  detector: '/models/det_10g.onnx', // SCRFD-10G (InsightFace buffalo_l)
  recognizer: '/models/w600k_r50.onnx', // ArcFace R50 (InsightFace buffalo_l)
  pose: '/models/pose_landmarker_full.task', // MediaPipe
  faceMesh: '/models/face_landmarker.task', // MediaPipe: expression and looking direction
  mediapipeWasm: '/mediapipe',
};

export interface Settings {
  detScore: number; // min face detection confidence
  minFacePx: number; // ignore faces smaller than this (in the stored photo)
  clusterSim: number; // cosine similarity needed to join a person group
  facesPerPage: number;
}

export const DEFAULT_SETTINGS: Settings = {
  detScore: 0.45,
  minFacePx: 32,
  clusterSim: 0.42,
  facesPerPage: 8,
};

// Stored copies of photos are downscaled to this longest side.
export const PHOTO_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 360;
// Cut-outs work on crops no bigger than this; stickers are at most 768 px anyway.
export const CROP_MAX_SIDE = 1024;
