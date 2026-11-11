import Dexie, { type EntityTable } from 'dexie';

export type Box = [number, number, number, number]; // x1, y1, x2, y2 in stored-photo pixels

export interface Photo {
  id: number;
  name: string;
  sourceKey: string; // name|size|lastModified, used to skip duplicates
  width: number;
  height: number;
  blob: Blob; // downscaled, EXIF-rotated JPEG
  thumb: Blob;
  status: 'pending' | 'done' | 'error';
  error?: string;
  addedAt: number;
}

export type CropKind = 'face' | 'upper' | 'full';

export interface CropOption {
  kind: CropKind;
  rect: Box; // in stored-photo pixels
  available: boolean;
  reason?: string;
}

export interface HeldObject {
  label: string; // COCO class, e.g. "bottle"
  score: number;
  box: Box;
  nearFace?: boolean; // at the face (a bottle at the mouth): kept in face stickers too
}

export type Expression = 'laughing' | 'smiling' | 'surprised' | 'ooh' | 'sleepy' | 'crying' | 'upset' | 'calm';
export type Looking = 'camera' | 'left' | 'right' | 'up' | 'down'; // as seen in the photo

export interface Face {
  id: number;
  photoId: number;
  box: Box;
  kps: number[]; // 5 landmarks, flattened x,y
  score: number;
  embedding: Float32Array;
  thumb: Blob;
  personId: number | null;
  locked: boolean; // user placed it manually; regrouping leaves it alone
  crops?: CropOption[];
  cropsVersion?: number; // crops are recomputed when the crop rules change
  best?: CropKind | null; // the sticker to make: face if big and sharp, else a body crop
  sharpness?: number;
  held?: HeldObject[]; // things the person holds, kept in the sticker
  expression?: Expression; // empty if the face couldn't be read
  looking?: Looking;
  expressionVersion?: number; // faces are read again when the rules change
}

export interface Person {
  id: number;
  name: string;
  coverFaceId: number | null;
  createdAt: number;
}

export type CaptionPos = 'top' | 'bottom';

/** Meme-style text on a sticker. Drawn live, never baked into the PNG. */
export interface Caption {
  text: string;
  style: string; // see CAPTION_STYLES
  pos: CaptionPos;
}

export interface Sticker {
  id: number;
  faceId: number;
  photoId: number;
  personId: number;
  kind: CropKind;
  blob: Blob; // PNG with transparency
  width: number;
  height: number;
  createdAt: number;
  // scrapbook placement (page coordinates, page is 1000 x 1400); page -1 = on the sticker sheet
  page: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  caption?: Caption;
  upright?: boolean; // made with the head turned right side up (see uprightTurn)
}

export interface Timing {
  id: number;
  step: string;
  ms: number;
  at: number;
  detail?: string;
}

export const db = new Dexie('cheekbook') as Dexie & {
  photos: EntityTable<Photo, 'id'>;
  faces: EntityTable<Face, 'id'>;
  people: EntityTable<Person, 'id'>;
  stickers: EntityTable<Sticker, 'id'>;
  timings: EntityTable<Timing, 'id'>;
};

db.version(1).stores({
  photos: '++id, sourceKey, status',
  faces: '++id, photoId, personId',
  people: '++id',
  stickers: '++id, personId, page, faceId',
  timings: '++id, step, at',
});

export async function logTiming(step: string, ms: number, detail?: string) {
  await db.timings.add({ step, ms: Math.round(ms), at: Date.now(), detail } as Timing);
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not supported */
  }
}
