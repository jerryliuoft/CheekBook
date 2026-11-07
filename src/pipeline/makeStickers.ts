import * as Comlink from 'comlink';
import { CROP_MAX_SIDE } from '../config';
import { db, logTiming, type Box, type CropKind, type Face, type HeldObject, type Sticker } from '../db';
import { computeCrops, hasCurrentCrops, heldIn } from '../lib/crops';
import { expressionFields, hasCurrentExpression, readFaces } from '../lib/expression';
import { detectObjects, segmentObjects } from '../lib/objects';
import { detectPoses, type Pose } from '../lib/pose';
import { faceSharpness } from '../lib/sharpness';
import { token } from '../lib/theme';
import { groupBy } from '../lib/util';
import type { CutoutResult } from '../workers/cutout.worker';
import { cutoutWorker, imageWorkers } from '../workers/clients';
import { SHEET } from './book';

export const needsAnalysis = (f: Face) => !hasCurrentCrops(f) || !hasCurrentExpression(f);

/**
 * Works out, and caches on each face, which crops are possible (pose model, once
 * per photo) and the face's expression and looking direction.
 */
export async function analyzeFaces(faces: Face[], onEach?: () => void) {
  const byPhoto = groupBy(faces.filter(needsAnalysis), (f) => f.photoId);
  for (const [photoId, list] of byPhoto) {
    const photo = await db.photos.get(photoId);
    if (!photo) continue;
    const updates = new Map<number, Partial<Face>>(list.map((f) => [f.id, {}]));

    const forCrops = list.filter((f) => !hasCurrentCrops(f));
    if (forCrops.length) {
      const t0 = performance.now();
      let poses: Pose[] = [];
      try {
        poses = await detectPoses(photo.blob);
      } catch (e) {
        console.warn('Pose detection failed', e);
      }
      await logTiming('detect pose', performance.now() - t0, `${poses.length} pose(s)`);
      const t1 = performance.now();
      let objects: HeldObject[] = [];
      try {
        objects = await detectObjects(photo.blob);
      } catch (e) {
        console.warn('Object detection failed', e);
      }
      await logTiming('detect objects', performance.now() - t1, `${objects.length} object(s)`);
      const bmp = await createImageBitmap(photo.blob);
      for (const f of forCrops) {
        const sharp = faceSharpness(bmp, f.kps);
        Object.assign(updates.get(f.id)!, computeCrops(f.box, photo.width, photo.height, poses, objects, sharp));
      }
      bmp.close();
    }

    const forExpr = list.filter((f) => !hasCurrentExpression(f));
    if (forExpr.length) {
      const t0 = performance.now();
      try {
        const read = await readFaces(photo.blob, forExpr.map((f) => f.box));
        forExpr.forEach((f, i) => Object.assign(updates.get(f.id)!, expressionFields(read[i])));
        await logTiming('read expression (per face)', (performance.now() - t0) / forExpr.length);
      } catch (e) {
        console.warn('Reading expressions failed', e);
      }
    }

    for (const [id, u] of updates) {
      await db.faces.update(id, u);
      onEach?.();
    }
  }
}

/** Maps a box in photo pixels into a (scaled) crop's pixels. */
function toLocal(b: Box, origin: Box, scale: number): Box {
  return [
    (b[0] - origin[0]) * scale,
    (b[1] - origin[1]) * scale,
    (b[2] - origin[0]) * scale,
    (b[3] - origin[1]) * scale,
  ];
}

type Cut = { image: Blob; faceBox: Box; result: CutoutResult };

/** Crops the photo for this kind of sticker and cuts the person out. */
async function cutOut(face: Face, photo: Blob, kind: CropKind, progress: (msg: string) => void): Promise<Cut | null> {
  const crop = face.crops?.find((c) => c.kind === kind);
  if (!crop?.available) return null;
  const cropped = await imageWorkers()[0].crop(photo, crop.rect, CROP_MAX_SIDE);
  const faceBox = toLocal(face.box, crop.rect, cropped.scale);
  const [lx, ly, rx, ry] = face.kps; // eye positions give the head's tilt
  const roll = Math.atan2(ry - ly, rx - lx);
  // A bottle or toy the baby holds stays in, outlined separately (the person
  // cut-out drops it, which can leave a hole in the face).
  const held = heldIn(face, kind, crop.rect).map((b) => toLocal(b, crop.rect, cropped.scale));
  let keep: Uint8Array | null = null;
  if (held.length) {
    try {
      keep = await segmentObjects(cropped.blob, held);
    } catch (e) {
      console.warn('Outlining held objects failed', e);
    }
  }
  // Face stickers are shaped to the head, so neighbours and clutter drop away.
  const result = await cutoutWorker().cutout(
    cropped.blob,
    faceBox,
    kind === 'face',
    roll,
    held,
    keep ? Comlink.transfer(keep, [keep.buffer]) : null,
    progress,
  );
  return { image: cropped.blob, faceBox, result };
}

/** Share of the face box the cut-out kept (0..1). */
function faceCoverage({ faceBox: b, result: { alpha, width } }: Cut): number {
  let kept = 0, n = 0;
  for (let y = Math.max(0, Math.round(b[1])); y < Math.round(b[3]); y++) {
    for (let x = Math.max(0, Math.round(b[0])); x < Math.min(width, Math.round(b[2])); x++) {
      const v = alpha[y * width + x];
      if (v === undefined) continue;
      n++;
      if (v > 128) kept++;
    }
  }
  return n ? kept / n : 0;
}

export interface StickerJob {
  faceId: number;
  kind: CropKind;
}

export async function makeStickers(jobs: StickerJob[], onProgress: (done: number, total: number, msg: string) => void) {
  const progress = Comlink.proxy((msg: string) => onProgress(0, jobs.length, msg));
  const canvas = imageWorkers()[0];
  const colors = { edge: token('--sticker-edge'), shadow: token('--sticker-shadow') };

  onProgress(0, jobs.length, 'Loading cut-out model…');
  const t0 = performance.now();
  await cutoutWorker().preload(jobs.some((j) => j.kind === 'face'), progress);
  await logTiming('load cut-out model', performance.now() - t0);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress(i, jobs.length, `Making sticker ${i + 1} of ${jobs.length}…`);
    const face = await db.faces.get(job.faceId);
    const photo = face && (await db.photos.get(face.photoId));
    if (!face || !photo || face.personId == null) continue;
    try {
      const t1 = performance.now();
      let kind = job.kind;
      let cut = await cutOut(face, photo.blob, kind, progress);
      // A body sticker must still show the face: when the face is soft the
      // cut-out can lose it and keep only an arm. Fall back to the face.
      if (cut && kind !== 'face' && faceCoverage(cut) < 0.5) {
        const asFace = await cutOut(face, photo.blob, 'face', progress);
        if (asFace && faceCoverage(asFace) > faceCoverage(cut)) [kind, cut] = ['face', asFace];
      }
      // Too blurry to cut out at all: no sticker, and don't offer this face again.
      if (!cut || faceCoverage(cut) < 0.4) {
        await db.faces.update(face.id, { best: null });
        onProgress(i, jobs.length, `Skipped a photo too soft to cut out`);
        continue;
      }
      const t2 = performance.now();
      const { alpha, width, height } = cut.result;
      const st = await canvas.sticker(cut.image, Comlink.transfer(alpha, [alpha.buffer]), width, height, colors);
      const t3 = performance.now();
      await logTiming('matting', cut.result.ms.matte, `${width}x${height}`);
      if (kind === 'face') await logTiming('face parsing', cut.result.ms.parse);
      await logTiming('sticker effect', t3 - t2);
      await logTiming('sticker total', t3 - t1, kind);

      // New stickers wait on the sticker sheet until placed or shuffled into the book.
      await db.stickers.add({
        faceId: face.id,
        photoId: photo.id,
        personId: face.personId,
        kind,
        blob: st.blob,
        width: st.width,
        height: st.height,
        createdAt: Date.now(),
        page: SHEET,
        x: 0,
        y: 0,
        rotation: 0,
        scale: 1,
      } as Sticker);
    } catch (e) {
      console.error('Sticker failed', e);
      onProgress(i, jobs.length, `Sticker ${i + 1} failed: ${e}`);
    }
  }
  onProgress(jobs.length, jobs.length, 'Done');
}

/** Faces of these people that have no sticker yet. */
export async function facesWithoutStickers(personIds: number[]): Promise<Face[]> {
  const faces = await db.faces.where('personId').anyOf(personIds).toArray();
  const made = new Set((await db.stickers.where('personId').anyOf(personIds).toArray()).map((s) => s.faceId));
  return faces.filter((f) => !made.has(f.id));
}

/**
 * Makes a sticker for every face of these people that doesn't have one yet,
 * choosing face or body for each (see bestKind in crops.ts).
 */
export async function makeStickersFor(
  personIds: number[],
  onProgress: (done: number, total: number, msg: string) => void,
): Promise<number> {
  const faces = await facesWithoutStickers(personIds);
  const stale = faces.filter(needsAnalysis);
  if (stale.length) {
    let done = 0;
    onProgress(0, stale.length, 'Looking at each photo…');
    await analyzeFaces(stale, () => onProgress(++done, stale.length, `Looking at each photo… ${done} / ${stale.length}`));
  }
  const fresh = await db.faces.bulkGet(faces.map((f) => f.id));
  const jobs = fresh.filter((f): f is Face => !!f?.best).map((f) => ({ faceId: f.id, kind: f.best! }));
  if (jobs.length) await makeStickers(jobs, onProgress);
  return jobs.length;
}
