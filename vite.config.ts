import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web needs
// for multi-threaded CPU inference. "credentialless" still lets us load models
// from the Hugging Face Hub and fonts from Google Fonts.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  // These ship their own wasm files; pre-bundling breaks the paths to them.
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
})
