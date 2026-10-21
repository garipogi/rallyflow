import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// docs/STACK.md layering: src/main (Electron main), src/preload, src/renderer (React UI).
// Everything is bundled locally; the renderer is loaded from disk, never from a URL.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), display: resolve('src/preload/display.ts') } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), display: resolve('src/renderer/display.html') } } },
  },
});
