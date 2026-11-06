import * as Comlink from 'comlink';
import { db, logTiming, type Box, type CropKind, type CropOption, type Face, type Sticker } from '../db';
import { computeCrops } from '../lib/crops';
import { trimToHead } from '../lib/mask';
import { detectPoses } from '../lib/pose';
import { getSettings } from '../settings';
import type { MatterKey } from '../config';
import { fallBackToCpu, imageWorkers, segWorker } from '../workers/clients';
import type { CutoutRequest } from '../workers/seg.worker';

export const PAGE_W = 1000;
export const PAGE_H = 1400;

/** Computes (and caches on the face) which crops are possible for each face. */
export async function ensureCrops(faces: Face[], onEach?: () => void) {
  const byPhoto = new Map<number, Face[]>();
  for (const f of faces) {
    if (f.crops) continue;
    const list = byPhoto.get(f.photoId) ?? [];
    list.push(f);
    byPhoto.set(f.photoId, list);
  }
  for (const [photoId, list] of byPhoto) {
    const photo = await db.photos.get(photoId);
    if (!photo) continue;
    const t0 = performance.now();
    let poses: Awaited<ReturnType<typeof detectPoses>> = [];
    try {
      poses = await detectPoses(photo.blob);
    } catch (e) {
      console.warn('Pose detection failed', e);
    }
    await logTiming('detect pose', performance.now() - t0, `${poses.length} pose(s)`);
    for (const f of list) {
      const crops = computeCrops(f.box, photo.width, photo.height, poses);
      await db.faces.update(f.id, { crops });
      onEach?.();
    }
  }
}

/** Cut-outs work on crops no bigger than this; stickers are at most 768 px anyway. */
const CROP_MAX_SIDE = 1024;

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
  const perPage = getSettings().facesPerPage;
  const last = await db.stickers.orderBy('page').last();
  if (!last) return 0;
  const onLast = await db.stickers.where('page').equals(last.page).count();
  return onLast >= perPage ? last.page + 1 : last.page;
}

export interface StickerJob {
  faceId: number;
  kind: CropKind;
}

export async function makeStickers(jobs: StickerJob[], onProgress: (done: number, total: number, msg: string) => void) {
  const settings = getSettings();
  const progress = Comlink.proxy((msg: string) => onProgress(0, jobs.length, msg));
  const matterFor = (): MatterKey => {
    const m = getSettings().matter;
    if (m !== 'auto') return m;
    return getSettings().cutoutDevice === 'gpu' ? 'birefnet-lite' : 'modnet';
  };

  async function preload() {
    const t = performance.now();
    const device = await segWorker().preload(settings.segmenter, matterFor(), progress);
    await logTiming('load cut-out models', performance.now() - t, `${device}, ${matterFor()}`);
  }

  onProgress(0, jobs.length, 'Loading cut-out models…');
  await preload();

  // If the GPU can't run a model, switch to the CPU once and retry.
  async function cutout(req: Omit<CutoutRequest, 'matter'>) {
    try {
      return await segWorker().cutout({ ...req, matter: matterFor() }, progress);
    } catch (e) {
      if (!fallBackToCpu()) throw e;
      console.warn('Cut-out failed on the GPU; switching to CPU', e);
      onProgress(0, jobs.length, 'The GPU could not run the cut-out model; switching to CPU…');
      await preload();
      return segWorker().cutout({ ...req, matter: matterFor() }, progress);
    }
  }

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress(i, jobs.length, `Making sticker ${i + 1} of ${jobs.length}…`);
    const face = await db.faces.get(job.faceId);
    const photo = face && (await db.photos.get(face.photoId));
    const crop = face?.crops?.find((c: CropOption) => c.kind === job.kind);
    if (!face || !photo || !crop?.available || face.personId == null) continue;
    try {
      const t1 = performance.now();
      const cropped = await imageWorkers()[0].crop(photo.blob, crop.rect, CROP_MAX_SIDE);
      const faceBox = toLocal(face.box, crop.rect, cropped.scale);
      const res = await cutout({
        image: cropped.blob,
        faceBox,
        bodyBox: toLocal(crop.bodyBox ?? crop.rect, crop.rect, cropped.scale),
        segmenter: settings.segmenter,
      });
      // Face stickers get a soft head-shaped trim so neighbours and clutter drop away.
      if (job.kind === 'face') trimToHead(res.alpha, res.width, res.height, faceBox);
      const t2 = performance.now();
      const st = await imageWorkers()[0].sticker(
        cropped.blob,
        Comlink.transfer(res.alpha, [res.alpha.buffer]),
        res.width,
        res.height,
      );
      const t3 = performance.now();
      await logTiming('matting', res.ms.matte, `${res.device} ${matterFor()}, ${res.width}x${res.height}`);
      if (res.usedSegmenter) await logTiming('segment person', res.ms.segment, `${settings.segmenter}, ${res.device}`);
      await logTiming('sticker effect', t3 - t2);
      await logTiming('sticker total', t3 - t1, job.kind);

      const page = await nextPage();
      const place = await placement(page, st.width, st.height);
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
        ...place,
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
    const place = await placement(page, s.width, s.height);
    await db.stickers.update(s.id, { ...place, page });
  }
}
