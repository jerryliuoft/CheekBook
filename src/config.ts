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

// Face and MediaPipe models load straight from their publishers' hosting, so
// this site serves only the app. Paths are pinned so a file never changes
// under us. InsightFace buffalo_l comes from Immich's Hugging Face copy (the
// same files as InsightFace's own release; weights are non-commercial).
const IMMICH = 'https://huggingface.co/immich-app/buffalo_l/resolve/d09715916a0778919a770c343533641e250b8699';
const MEDIAPIPE = 'https://storage.googleapis.com/mediapipe-models';
// Must match the installed @mediapipe/tasks-vision version (pinned in package.json).
const MEDIAPIPE_VERSION = '1.2.2';

export const FACE_MODELS = {
  detector: `${IMMICH}/detection/model.onnx`, // SCRFD-10G, 17 MB
  recognizer: `${IMMICH}/recognition/model.onnx`, // ArcFace R50, 174 MB
  pose: `${MEDIAPIPE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  faceMesh: `${MEDIAPIPE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, // expression and looking direction
  objects: `${MEDIAPIPE}/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite`, // bottles, toys and other held things
  magicTouch: `${MEDIAPIPE}/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`, // outlines a held thing
  mediapipeWasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
};

export interface Settings {
  detScore: number; // min face detection confidence
  minFacePx: number; // ignore faces smaller than this (in the stored photo)
  clusterSim: number; // cosine similarity needed to join a person group
  perPage: number; // most stickers a shuffle puts on a page; 0 = as many as fit
  bookStyle: string; // see BOOK_STYLES
  autoCaption: boolean; // new stickers get a caption picked from their expression
  captionLang: string; // 'zh' | 'en' | 'both'
  captionStyle: string; // style for new captions, see CAPTION_STYLES
}

export const DEFAULT_SETTINGS: Settings = {
  detScore: 0.45,
  minFacePx: 32,
  clusterSim: 0.42,
  perPage: 0,
  bookStyle: 'linen',
  autoCaption: true,
  captionLang: 'zh',
  captionStyle: 'classic',
};

// Stored copies of photos are downscaled to this longest side.
export const PHOTO_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 360;
// Cut-outs work on crops no bigger than this; stickers are at most 768 px anyway.
export const CROP_MAX_SIDE = 1024;
