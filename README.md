# CheekBook

A sticker scrapbook of your baby's cheeks. Load a folder of photos, and CheekBook finds every face, groups faces by person, cuts the chosen person out as a die-cut sticker (face, upper body or full body), and scatters the stickers across scrapbook pages.

Everything runs in the browser. Photos never leave your computer.

## Getting started

Requires Node 20+ and a Chromium browser (Chrome or Edge) on a desktop or laptop.

```bash
npm install
npm run models   # downloads face, pose and face-mesh models (~200 MB) into public/models
npm run dev
```

Open http://localhost:5173. The first time you make stickers, the browser also downloads the cut-out models from the Hugging Face Hub (MODNet, 26 MB, and face parsing, 89 MB) and caches them.

## How it works

| Step | What happens | Model / library |
|---|---|---|
| 1 · Photos | Each photo is copied into the browser (IndexedDB), EXIF-rotated and downscaled to 2048 px, in a pool of Web Workers | OffscreenCanvas, Dexie |
| | Faces are found and fingerprinted (in a Web Worker) | SCRFD-10G + ArcFace R50 (InsightFace `buffalo_l`) via onnxruntime-web, WebGPU with wasm fallback |
| 2 · People | Faces are grouped by cosine similarity; you merge groups and remove wrong faces | `src/lib/cluster.ts` |
| 3 · Stickers | Body pose decides which crops are offered (face / upper / full) and whether they're big enough | MediaPipe Pose Landmarker |
| | Each face is tagged with an expression (laughing, smiling, surprised, ooh, eyes closed, crying, upset, calm) and where it looks (camera, left, right, up, down); filters narrow the list | MediaPipe Face Landmarker blendshapes + rules in `src/lib/expression.ts` |
| | The person is cut out on a crop of at most 1024 px; face stickers are shaped to the head by face parsing (hair, ears and chin in; neck, clothes, hands and background out) | MODNet + SegFormer face parsing via Transformers.js (CPU) |
| | The cut-out becomes a sticker (white border, shadow) | OffscreenCanvas in a Web Worker |
| 4 · Scrapbook | Stickers are scattered on pages; drag, rotate and resize them | react-konva |

The **Lab** tab has thresholds and a timing table for every step on your computer.

## Code map

```
src/
  config.ts             model ids and default thresholds (swap models here)
  db.ts                 IndexedDB schema (photos, faces, people, stickers, timings)
  workers/image.worker.ts  photo decode + resize + thumbnail (off the main thread)
  workers/face.worker.ts   SCRFD detection + ArcFace embeddings (onnxruntime-web)
  workers/cutout.worker.ts MODNet matting + face parsing (Transformers.js, CPU)
  workers/clients.ts       one lazily created instance of each worker
  pipeline/             import → detect → group; crop → cut out → sticker → place
  lib/                  geometry, clustering, crop rules, masks, sticker effect, pose, expression, util helpers
  components/           one view per tab
  styles/theme.css      the design system: every colour, font, corner, line and shadow
  index.css             app styles, built only from theme tokens
scripts/fetch-models.mjs  downloads model weights into public/models
scripts/check-theme.mjs   part of `npm run lint`: fails on colours written outside theme.css
```

## Look and feel

The theme is "Oat & Espresso": oat and cream surfaces, espresso text and buttons, camel and sage accents, Cormorant Garamond for headings and Jost for text, thin lines and small corners. It is light only. To change the look, edit the tokens in `src/styles/theme.css`. New UI uses `var(--color-…)` and friends, and canvas code reads tokens with `token()` from `src/lib/theme.ts`. A line that truly needs a raw colour (for example a model's input canvas) can opt out with a `theme-ok` comment.

## Notes and known limits

- **Cut-outs run on the CPU only.** On the dev machine WebGPU returned broken masks for MODNet with no error, and couldn't run BiRefNet at all (too few storage buffers per shader); BiRefNet on the CPU ran out of memory. MODNet on the CPU is clean and takes about 0.5 s per sticker. The GPU/BiRefNet path was removed; it is in git history (commit 8ed8eae and earlier) if needed.
- **Encode images in workers.** Chrome delays `convertToBlob`/`toBlob` JPEG encoding on the main thread until it's idle (about 1 s per call); in a worker it takes 50–80 ms. Photo import does its resizing in `image.worker.ts` for this reason.
- **SAM was tried and removed.** SAM 2.1 removed parts of the body and didn't separate a baby from the parent holding them. Face stickers use face parsing instead.
- **Face parsing** adds about 0.6 s per face sticker (256 px input; 512 px looked no better and took 2.2 s). The parser only knows upright faces, so tilted heads (a baby lying down) are rotated upright by the eye line before parsing. Its 64 × 64 map is upsampled from soft scores and snapped to the photo's edges with a guided filter, so edges stay smooth. On photos with a black background, dark background next to the head can be kept as hair.
- **Upper/full-body stickers of a baby being held** will include the parent.
- **Baby face grouping** is imperfect (models are trained on adults); use Merge and "Not this person".
- **iPhone HEIC photos** aren't supported yet.
- **Expressions** come from a face-mesh model trained on adults. On 29 baby faces the labels were right on 27 (one big grin read as calm, one faint smile as calm). Crying and upset aren't tested yet: no photos of them. Left and right are as seen in the photo; smiling adults often read as looking down because their eyes squint.
- **Licences:** the InsightFace `buffalo_l` weights and the face-parsing model (trained on CelebAMask-HQ) are for non-commercial use only. MODNet (Apache-2.0), MediaPipe (Apache-2.0).
