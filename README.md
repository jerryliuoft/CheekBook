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
| 1 · Photos | Each photo is copied into the browser (IndexedDB), EXIF-rotated and downscaled to 2048 px | Canvas, Dexie |
| | Faces are found and fingerprinted (in a Web Worker) | SCRFD-10G + ArcFace R50 (InsightFace `buffalo_l`) via onnxruntime-web, WebGPU with wasm fallback |
| 2 · People | Faces are grouped by cosine similarity; you merge groups and remove wrong faces | `src/lib/cluster.ts` |
| 3 · Stickers | Body pose decides which crops are offered (face / upper / full) and whether they're big enough | MediaPipe Pose Landmarker |
| | The person is cut out, cleaned up, and turned into a sticker (white border, shadow) | MODNet (CPU) or BiRefNet (GPU) via Transformers.js; optional SAM 2.1 / SAM 3 |
| 4 · Scrapbook | Stickers are scattered on pages; drag, rotate and resize them | react-konva |

The **Lab** tab has thresholds, model choices, and a timing table for every step on your computer.

## Code map

```
src/
  config.ts             model ids and default thresholds (swap models here)
  db.ts                 IndexedDB schema (photos, faces, people, stickers, timings)
  workers/face.worker.ts   SCRFD detection + ArcFace embeddings (onnxruntime-web)
  workers/seg.worker.ts    matting + segmentation (Transformers.js)
  pipeline/             import → detect → group; crop → cut out → sticker → place
  lib/                  geometry, clustering, crop rules, masks, sticker effect, pose
  components/           one view per tab
scripts/fetch-models.mjs  downloads model weights into public/models
```

## Notes and known limits

- **GPU cut-outs are opt-in.** On the dev machine the GPU returned broken masks for MODNet and couldn't run BiRefNet at all (too few storage buffers per shader). Cut-outs therefore default to the CPU, which takes about 1 s per sticker with MODNet.
- **SAM is off by default.** In testing it removed parts of the body and didn't separate a baby from the parent holding them. Face stickers use a soft head-shaped trim instead.
- **Upper/full-body stickers of a baby being held** will include the parent.
- **Baby face grouping** is imperfect (models are trained on adults); use Merge and "Not this person".
- **iPhone HEIC photos** aren't supported yet.
- **Licences:** the InsightFace `buffalo_l` weights are for non-commercial use only. MODNet (Apache-2.0), BiRefNet (MIT), MediaPipe (Apache-2.0).
