// Central place for model choices and tunable thresholds.
// Models are swappable: change an id here (or in the Lab tab) to try another one.

export const SEGMENTERS = {
  none: { id: '', kind: 'none', label: 'Off (recommended)' },
  'sam2.1-tiny': { id: 'onnx-community/sam2.1-hiera-tiny-ONNX', kind: 'sam2', label: 'SAM 2.1 tiny (~70 MB, experimental)' },
  sam3: { id: 'onnx-community/sam3-tracker-ONNX', kind: 'sam3', label: 'SAM 3 tracker (~300 MB+, experimental)' },
} as const;
export type SegmenterKey = keyof typeof SEGMENTERS;

export const MATTERS = {
  'birefnet-lite': { id: 'onnx-community/BiRefNet_lite-ONNX', kind: 'birefnet', label: 'BiRefNet lite (~115 MB, GPU)' },
  'birefnet-portrait': { id: 'onnx-community/BiRefNet-portrait-ONNX', kind: 'birefnet', label: 'BiRefNet portrait (~490 MB, GPU)' },
  modnet: { id: 'Xenova/modnet', kind: 'modnet', label: 'MODNet (~26 MB, works on CPU)' },
} as const;
export type MatterKey = keyof typeof MATTERS;
// 'auto' = BiRefNet on the GPU, MODNet on the CPU.
export type MatterChoice = MatterKey | 'auto';

export const FACE_MODELS = {
  detector: '/models/det_10g.onnx', // SCRFD-10G (InsightFace buffalo_l)
  recognizer: '/models/w600k_r50.onnx', // ArcFace R50 (InsightFace buffalo_l)
  pose: '/models/pose_landmarker_full.task', // MediaPipe
  mediapipeWasm: '/mediapipe',
};

export interface Settings {
  detScore: number; // min face detection confidence
  minFacePx: number; // ignore faces smaller than this (in the stored photo)
  clusterSim: number; // cosine similarity needed to join a person group
  segmenter: SegmenterKey;
  matter: MatterChoice;
  cutoutDevice: 'cpu' | 'gpu';
  facesPerPage: number;
}

export const DEFAULT_SETTINGS: Settings = {
  detScore: 0.45,
  minFacePx: 32,
  clusterSim: 0.42,
  segmenter: 'none',
  matter: 'auto',
  cutoutDevice: 'cpu',
  facesPerPage: 8,
};

// Stored copies of photos are downscaled to this longest side.
export const PHOTO_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 360;
