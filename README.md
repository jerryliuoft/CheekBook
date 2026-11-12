# CheekBook

A sticker scrapbook of your baby's cheeks. Load a folder of photos, and CheekBook finds every face, groups faces by person, cuts the people you pick out as die-cut stickers, and lets you lay them out in a page-turning scrapbook.

Everything runs in the browser. Photos never leave your computer.

## Getting started

Requires Node 20+ and a Chromium browser (Chrome or Edge) on a desktop or laptop.

```bash
npm install
npm run dev
```

Open http://localhost:5173. No model files live in this repo or on the site: the browser downloads them on first use and keeps them in Cache Storage. Face models (InsightFace buffalo_l, 191 MB) come from Immich's Hugging Face copy, MediaPipe models (31 MB) from Google's model storage, the onnxruntime and MediaPipe engines from jsDelivr, and the cut-out models (MODNet, 26 MB, and face parsing, 89 MB) from the Hugging Face Hub. The sources are pinned in `src/config.ts`.

## Live site

https://cheekbook-baby.web.app, on Firebase Hosting's free Spark plan (no billing account, so it can't cost money). To deploy a new version:

```bash
npm run build
firebase deploy --only hosting
```

`firebase.json` sends the cross-origin isolation headers and leaves `dev-photos/` out of the upload. Firebase serves only the app (a few MB); every model downloads from its publisher's hosting, so the free plan's 360 MB a day covers well over a hundred new visitors. Past the limit the site goes offline until the next day; it is never billed.

## How it works

| Step | What happens | Model / library |
|---|---|---|
| 1 · Photos & people | Each photo is copied into the browser (IndexedDB), EXIF-rotated and downscaled to 2048 px, in a pool of Web Workers | OffscreenCanvas, Dexie |
| | Faces are found and fingerprinted (in a Web Worker) | SCRFD-10G + ArcFace R50 (InsightFace `buffalo_l`) via onnxruntime-web, WebGPU with wasm fallback |
| | Faces are grouped by cosine similarity; you merge groups, remove wrong faces and pick who gets stickers | `src/lib/cluster.ts` |
| | Each face gets one sticker, chosen automatically: the face when it is at least 120 px and sharp around the eyes (score 0.09 or more), otherwise the upper or full body (from the body pose). A baby holding something away from the face also gets a body sticker | MediaPipe Pose Landmarker, `src/lib/sharpness.ts`, `bestKind` in `src/lib/crops.ts` |
| | Bottles, cups, toys and other hand-sized things the person holds are found and outlined, and kept in the sticker (with the hands around them) | MediaPipe EfficientDet-Lite2 + MagicTouch, `src/lib/objects.ts` |
| | Each face is tagged with an expression (laughing, smiling, surprised, ooh, eyes closed, crying, upset, calm) and where it looks | MediaPipe Face Landmarker blendshapes + rules in `src/lib/expression.ts` |
| | The person is cut out on a crop of at most 1024 px; face stickers are shaped to the head by face parsing (hair, ears and chin in; neck, clothes and background out) | MODNet + SegFormer face parsing via Transformers.js (CPU) |
| | The cut-out becomes a sticker (white border, shadow) and goes on the sticker sheet. A head tilted more than 30° (a baby lying down, a sideways photo) is turned right side up first; older sideways stickers can be fixed from a notice above the book | OffscreenCanvas in a Web Worker, `uprightTurn` in `src/pipeline/makeStickers.ts` |
| | New stickers get a meme-style caption (表情包) picked from their expression, in Chinese, English or both | `src/lib/caption.ts` |
| 2 · Scrapbook | An album (five styles) with page-turn animation, and the sticker sheet beside it. Click or drag a sticker onto the page, drag one off the page to put it back, or shuffle every sticker into the book (up to N a page, or as many as fit). Drag, rotate and resize on the page | react-konva, `src/pipeline/book.ts` |
| | Select a sticker to edit its caption: type your own, 🎲 for another idea, pick a style (经典 Classic, 可爱 Cute, 手写 Handwritten, 气泡 Bubble), put it above or below. Captions are drawn live and never baked into the sticker, so "Remove captions" undoes them all | `src/lib/caption.ts`, Noto Sans SC, ZCOOL KuaiLe and Ma Shan Zheng via Fontsource |

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
  pipeline/             import → detect → group; analyse → cut out → sticker; book layout (book.ts)
  lib/                  geometry, clustering, crop rules, masks, sticker effect, pose, expression, objects, sharpness, album styles, captions
  components/           one view per tab
  styles/theme.css      the design system: every colour, font, corner, line and shadow
  index.css             app styles, built only from theme tokens
scripts/check-theme.mjs   part of `npm run lint`: fails on colours written outside theme.css
```

## Look and feel

The theme is "Oat & Espresso": oat and cream surfaces, espresso text and buttons, camel and sage accents, Cormorant Garamond for headings and Jost for text, thin lines and small corners. It is light only. The album styles (Linen, Gallery, Kraft, Sage, Noir) are blocks of tokens under `[data-book=…]` in the same file, with their names and page titles in `src/lib/bookStyles.ts`. To change the look, edit the tokens in `src/styles/theme.css`. New UI uses `var(--color-…)` and friends, and canvas code reads tokens with `token()` from `src/lib/theme.ts`. Caption colours and fonts are the `--caption-…` and `--font-caption-…` tokens. The caption fonts are bundled with the app (no Google Fonts requests) and split by character range, so the browser fetches only the pieces for the characters on screen. A line that truly needs a raw colour (for example a model's input canvas) can opt out with a `theme-ok` comment.

## Notes and known limits

- **Cut-outs run on the CPU only.** On the dev machine WebGPU returned broken masks for MODNet with no error, and couldn't run BiRefNet at all (too few storage buffers per shader); BiRefNet on the CPU ran out of memory. MODNet on the CPU is clean and takes about 0.5 s per sticker. The GPU/BiRefNet path was removed; it is in git history (commit 8ed8eae and earlier) if needed.
- **Encode images in workers.** Chrome delays `convertToBlob`/`toBlob` JPEG encoding on the main thread until it's idle (about 1 s per call); in a worker it takes 50–80 ms. Photo import does its resizing in `image.worker.ts` for this reason.
- **SAM was tried and removed.** SAM 2.1 removed parts of the body and didn't separate a baby from the parent holding them. Face stickers use face parsing instead.
- **Face parsing** adds about 0.6 s per face sticker (256 px input; 512 px looked no better and took 2.2 s). Both cut-out models were trained on upright portraits, so a tilted face crop (a baby lying down) is turned upright by the eye line first and the mask turned back. The inner face from detection is always kept and bites in the head outline are filled, since the parser sometimes misses a baby's face. Its 64 × 64 map is upsampled from soft scores and snapped to the photo's edges with a guided filter, so edges stay smooth. On photos with a black background, dark background next to the head can be kept as hair.
- **Upper/full-body stickers of a baby being held** will include the parent.
- **Held objects:** the COCO object detector often gets the label wrong (a bottle read as a "remote", a red envelope as a "book"), so any hand-sized object counts; people, furniture and vehicles don't. A detected "object" whose outline spreads far past its box is ignored: it is usually a cheek or the whole baby. Toys the detector doesn't know won't be found.
- **Sharpness** is measured around the eyes, since baby skin is smooth even when in focus. A face in profile (eyes hidden) scores low and gets a body sticker. A sticker that loses the face entirely (a very soft photo) falls back to a face sticker, or is skipped.
- **Baby face grouping** is imperfect (models are trained on adults); use Merge and "Not this person".
- **iPhone HEIC photos** aren't supported yet.
- **Expressions** come from a face-mesh model trained on adults. On 29 baby faces the labels were right on 27 (one big grin read as calm, one faint smile as calm). Crying and upset aren't tested yet: no photos of them. Left and right are as seen in the photo; smiling adults often read as looking down because their eyes squint.
- **Licences:** the InsightFace `buffalo_l` weights and the face-parsing model (trained on CelebAMask-HQ) are for non-commercial use only. MODNet (Apache-2.0), MediaPipe (Apache-2.0).
