# CheekBook

A sticker scrapbook of your baby's cheeks. Load a folder of photos, and CheekBook finds every face, groups faces by person, cuts the chosen person out as a die-cut sticker (face, upper body or full body), and scatters the stickers across scrapbook pages.

Everything runs in the browser. Photos never leave your computer.

## Getting started

Requires Node 20+ and a Chromium browser (Chrome or Edge) on a desktop or laptop.

```bash
npm install
npm run models   # downloads face + pose models (~200 MB) into public/models
npm run dev
```

Open http://localhost:5173. The first time you make stickers, the browser also downloads the cut-out model from the Hugging Face Hub (26 MB for the default MODNet) and caches it.

## How it works

| Step | What happens | Model / library |
|---|---|---|
| 1 · Photos | Each photo is copied into the browser (IndexedDB), EXIF-rotated and downscaled to 2048 px, in a pool of Web Workers | OffscreenCanvas, Dexie |
| | Faces are found and fingerprinted (in a Web Worker) | SCRFD-10G + ArcFace R50 (InsightFace `buffalo_l`) via onnxruntime-web, WebGPU with wasm fallback |
| 2 · People | Faces are grouped by cosine similarity; you merge groups and remove wrong faces | `src/lib/cluster.ts` |
| 3 · Stickers | Body pose decides which crops are offered (face / upper / full) and whether they're big enough | MediaPipe Pose Landmarker |
| | The person is cut out on a crop of at most 1024 px, cleaned up, and turned into a sticker (white border, shadow) | MODNet via Transformers.js (CPU), canvas work in a Web Worker |
| 4 · Scrapbook | Stickers are scattered on pages; drag, rotate and resize them | react-konva |

The **Lab** tab has thresholds and a timing table for every step on your computer.

## Code map

```
src/
  config.ts             model ids and default thresholds (swap models here)
  db.ts                 IndexedDB schema (photos, faces, people, stickers, timings)
  workers/image.worker.ts  photo decode + resize + thumbnail (off the main thread)
  workers/face.worker.ts   SCRFD detection + ArcFace embeddings (onnxruntime-web)
  workers/cutout.worker.ts MODNet person matting (Transformers.js, CPU)
  workers/clients.ts       one lazily created instance of each worker
  pipeline/             import → detect → group; crop → cut out → sticker → place
  lib/                  geometry, clustering, crop rules, masks, sticker effect, pose, util helpers
  components/           one view per tab
scripts/fetch-models.mjs  downloads model weights into public/models
```

## Notes and known limits

- **Cut-outs run on the CPU only.** On the dev machine WebGPU returned broken masks for MODNet with no error, and couldn't run BiRefNet at all (too few storage buffers per shader); BiRefNet on the CPU ran out of memory. MODNet on the CPU is clean and takes about 0.5 s per sticker. The GPU/BiRefNet path was removed; it is in git history (commit 8ed8eae and earlier) if needed.
- **Encode images in workers.** Chrome delays `convertToBlob`/`toBlob` JPEG encoding on the main thread until it's idle (about 1 s per call); in a worker it takes 50–80 ms. Photo import does its resizing in `image.worker.ts` for this reason.
- **SAM was tried and removed.** SAM 2.1 removed parts of the body and didn't separate a baby from the parent holding them. Face stickers use a soft head-shaped trim instead.
- **Upper/full-body stickers of a baby being held** will include the parent.
- **Baby face grouping** is imperfect (models are trained on adults); use Merge and "Not this person".
- **iPhone HEIC photos** aren't supported yet.
- **Licences:** the InsightFace `buffalo_l` weights are for non-commercial use only. MODNet (Apache-2.0), MediaPipe (Apache-2.0).
