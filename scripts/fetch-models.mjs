// Downloads the model weights that are served locally from public/models,
// and copies MediaPipe's wasm runtime into public/mediapipe.
// Run with: npm run models
//
// Transformers.js models (segmentation, matting) are NOT fetched here: the
// browser downloads them from the Hugging Face Hub on first use and caches them.

import { createWriteStream, existsSync, mkdirSync, cpSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'models');
mkdirSync(modelsDir, { recursive: true });

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

function unzip(zip, files, outDir) {
  // bsdtar (Windows, macOS) reads zip; fall back to unzip on Linux.
  try {
    execFileSync('tar', ['-xf', zip, '-C', outDir, ...files], { stdio: 'inherit' });
  } catch {
    execFileSync('unzip', ['-o', zip, ...files, '-d', outDir], { stdio: 'inherit' });
  }
}

// 1. InsightFace buffalo_l: SCRFD-10G face detector + ArcFace R50 recognizer.
//    Official release from deepinsight/insightface. Weights are non-commercial.
const faceFiles = ['det_10g.onnx', 'w600k_r50.onnx'];
if (!faceFiles.every((f) => existsSync(join(modelsDir, f)))) {
  const zip = join(modelsDir, 'buffalo_l.zip');
  if (!existsSync(zip)) {
    await download('https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip', zip);
  }
  unzip(zip, faceFiles, modelsDir);
  rmSync(zip);
} else {
  console.log('Face models already present');
}

// 2. MediaPipe pose landmarker (Apache-2.0).
const pose = join(modelsDir, 'pose_landmarker_full.task');
if (!existsSync(pose)) {
  await download(
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
    pose,
  );
} else {
  console.log('Pose model already present');
}

// 3. MediaPipe wasm runtime, copied from node_modules so nothing loads from a CDN.
cpSync(join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), join(root, 'public', 'mediapipe'), {
  recursive: true,
});

console.log('Models ready in public/models');
