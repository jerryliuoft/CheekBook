import { PHOTO_MAX_SIDE, THUMB_MAX_SIDE } from '../config';
import { db, logTiming, requestPersistence, type Face, type Photo } from '../db';
import { groupFaces } from '../lib/cluster';
import { isImageFile, normalizeImage } from '../lib/image';
import { getSettings } from '../settings';
import { faceWorker } from '../workers/clients';

export interface ImportProgress {
  phase: 'copying' | 'loading-models' | 'finding-faces' | 'grouping' | 'done';
  done: number;
  total: number;
  message?: string;
}

type OnProgress = (p: ImportProgress) => void;

/** Copies the chosen files into the browser's storage (downscaled), skipping duplicates. */
export async function addFiles(files: File[], onProgress: OnProgress): Promise<number> {
  await requestPersistence();
  const images = files.filter(isImageFile);
  let added = 0;
  for (let i = 0; i < images.length; i++) {
    const f = images[i];
    const sourceKey = `${f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}`;
    onProgress({ phase: 'copying', done: i, total: images.length, message: f.name });
    if (await db.photos.where('sourceKey').equals(sourceKey).count()) continue;
    try {
      const t0 = performance.now();
      const main = await normalizeImage(f, PHOTO_MAX_SIDE);
      const thumb = await normalizeImage(main.blob, THUMB_MAX_SIDE, 0.8);
      await db.photos.add({
        name: f.webkitRelativePath || f.name,
        sourceKey,
        width: main.width,
        height: main.height,
        blob: main.blob,
        thumb: thumb.blob,
        status: 'pending',
        addedAt: Date.now(),
      } as Photo);
      await logTiming('copy photo', performance.now() - t0);
      added++;
    } catch (e) {
      console.warn('Could not read', f.name, e);
    }
  }
  return added;
}

let running = false;

/** Finds faces in every pending photo, then groups new faces into people. Resumable. */
export async function processPending(onProgress: OnProgress) {
  if (running) return;
  running = true;
  try {
    const pendingIds = (await db.photos.where('status').equals('pending').primaryKeys()) as number[];
    if (pendingIds.length) {
      onProgress({ phase: 'loading-models', done: 0, total: pendingIds.length });
      const worker = faceWorker();
      const t0 = performance.now();
      const info = await worker.init();
      await logTiming('load face models', performance.now() - t0, `${info.provider}, ${info.threads} thread(s)`);

      const settings = getSettings();
      for (let i = 0; i < pendingIds.length; i++) {
        onProgress({ phase: 'finding-faces', done: i, total: pendingIds.length });
        const photo = await db.photos.get(pendingIds[i]);
        if (!photo || photo.status !== 'pending') continue;
        try {
          const res = await worker.analyze(photo.blob, {
            scoreThreshold: settings.detScore,
            minFacePx: settings.minFacePx,
          });
          await db.transaction('rw', db.faces, db.photos, async () => {
            await db.faces.where('photoId').equals(photo.id).delete();
            await db.faces.bulkAdd(
              res.faces.map(
                (f) =>
                  ({
                    photoId: photo.id,
                    box: f.box,
                    kps: f.kps,
                    score: f.score,
                    embedding: f.embedding,
                    thumb: f.thumb,
                    personId: null,
                    locked: false,
                  }) as Face,
              ),
            );
            await db.photos.update(photo.id, { status: 'done' });
          });
          await logTiming('detect faces', res.ms.detect, `${info.provider}`);
          if (res.faces.length) await logTiming('face fingerprint (per face)', res.ms.embed / res.faces.length);
        } catch (e) {
          console.error(e);
          await db.photos.update(photo.id, { status: 'error', error: String(e) });
        }
      }
    }
    onProgress({ phase: 'grouping', done: 0, total: 1 });
    const t1 = performance.now();
    await groupFaces(getSettings().clusterSim);
    await logTiming('group faces', performance.now() - t1);
    onProgress({ phase: 'done', done: pendingIds.length, total: pendingIds.length });
  } finally {
    running = false;
  }
}
