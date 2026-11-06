import * as Comlink from 'comlink';
import { CROP_MAX_SIDE } from '../config';
import { db, logTiming, type Box, type CropKind, type Face, type Sticker } from '../db';
import { computeCrops, hasCurrentCrops } from '../lib/crops';
import { detectPoses, type Pose } from '../lib/pose';
import { groupBy } from '../lib/util';
import { getSettings } from '../settings';
import { cutoutWorker, imageWorkers } from '../workers/clients';

export const PAGE_W = 1000;
export const PAGE_H = 1400;

/** Computes (and caches on the face) which crops are possible for each face. */
export async function ensureCrops(faces: Face[], onEach?: () => void) {
  const byPhoto = groupBy(
    faces.filter((f) => !hasCurrentCrops(f)),
    (f) => f.photoId,
  );
  for (const [photoId, list] of byPhoto) {
    const photo = await db.photos.get(photoId);
    if (!photo) continue;
    const t0 = performance.now();
    let poses: Pose[] = [];
    try {
      poses = await detectPoses(photo.blob);
    } catch (e) {
      console.warn('Pose detection failed', e);
    }
    await logTiming('detect pose', performance.now() - t0, `${poses.length} pose(s)`);
    for (const f of list) {
      await db.faces.update(f.id, computeCrops(f.box, photo.width, photo.height, poses));
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

/** Picks a spot on the page that overlaps existing stickers as little as possible. */
async function placement(page: number, w: number, h: number) {
  const existing = await db.stickers.where('page').equals(page).toArray();
  const target = 300 + Math.random() * 90; // longest side on the page
  const scale = target / Math.max(w, h);
  const sw = w * scale, sh = h * scale;
  let best = { x: PAGE_W / 2, y: PAGE_H / 2, overlap: Infinity };
  for (let i = 0; i < 40; i++) {
    const x = sw / 2 + 30 + Math.random() * (PAGE_W - sw - 60);
    const y = sh / 2 + 90 + Math.random() * (PAGE_H - sh - 130);
    let overlap = 0;
    for (const s of existing) {
      const ow = s.width * s.scale, oh = s.height * s.scale;
      const dx = Math.max(0, Math.min(x + sw / 2, s.x + ow / 2) - Math.max(x - sw / 2, s.x - ow / 2));
      const dy = Math.max(0, Math.min(y + sh / 2, s.y + oh / 2) - Math.max(y - sh / 2, s.y - oh / 2));
      overlap += dx * dy;
    }
    if (overlap < best.overlap) best = { x, y, overlap };
  }
  return { x: best.x, y: best.y, scale, rotation: (Math.random() - 0.5) * 22 };
}

async function nextPage(): Promise<number> {
  const last = await db.stickers.orderBy('page').last();
  if (!last) return 0;
  const onLast = await db.stickers.where('page').equals(last.page).count();
  return onLast >= getSettings().facesPerPage ? last.page + 1 : last.page;
}

export interface StickerJob {
  faceId: number;
  kind: CropKind;
}

export async function makeStickers(jobs: StickerJob[], onProgress: (done: number, total: number, msg: string) => void) {
  const progress = Comlink.proxy((msg: string) => onProgress(0, jobs.length, msg));
  const canvas = imageWorkers()[0];

  onProgress(0, jobs.length, 'Loading cut-out model…');
  const t0 = performance.now();
  await cutoutWorker().preload(jobs.some((j) => j.kind === 'face'), progress);
  await logTiming('load cut-out model', performance.now() - t0);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress(i, jobs.length, `Making sticker ${i + 1} of ${jobs.length}…`);
    const face = await db.faces.get(job.faceId);
    const photo = face && (await db.photos.get(face.photoId));
    const crop = face?.crops?.find((c) => c.kind === job.kind);
    if (!face || !photo || !crop?.available || face.personId == null) continue;
    try {
      const t1 = performance.now();
      const cropped = await canvas.crop(photo.blob, crop.rect, CROP_MAX_SIDE);
      const faceBox = toLocal(face.box, crop.rect, cropped.scale);
      // Face stickers are shaped to the head, so neighbours and clutter drop away.
      const cut = await cutoutWorker().cutout(cropped.blob, faceBox, job.kind === 'face', progress);
      const t2 = performance.now();
      const st = await canvas.sticker(cropped.blob, Comlink.transfer(cut.alpha, [cut.alpha.buffer]), cut.width, cut.height);
      const t3 = performance.now();
      await logTiming('matting', cut.ms.matte, `${cut.width}x${cut.height}`);
      if (job.kind === 'face') await logTiming('face parsing', cut.ms.parse);
      await logTiming('sticker effect', t3 - t2);
      await logTiming('sticker total', t3 - t1, job.kind);

      const page = await nextPage();
      await db.stickers.add({
        faceId: face.id,
        photoId: photo.id,
        personId: face.personId,
        kind: job.kind,
        blob: st.blob,
        width: st.width,
        height: st.height,
        createdAt: Date.now(),
        page,
        ...(await placement(page, st.width, st.height)),
      } as Sticker);
    } catch (e) {
      console.error('Sticker failed', e);
      onProgress(i, jobs.length, `Sticker ${i + 1} failed: ${e}`);
    }
  }
  onProgress(jobs.length, jobs.length, 'Done');
}

export async function reshufflePage(page: number) {
  const stickers = await db.stickers.where('page').equals(page).toArray();
  await db.stickers.where('page').equals(page).modify({ page: -1 });
  for (const s of stickers) {
    await db.stickers.update(s.id, { ...(await placement(page, s.width, s.height)), page });
  }
}
