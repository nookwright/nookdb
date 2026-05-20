import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: { outDir: 'dist-electron', lib: { entry: 'electron/main.ts' } },
  },
  preload: {
    build: { outDir: 'dist-electron', lib: { entry: 'electron/preload.ts' } },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: 'index.html',
        // nookdb uses node:module / node:crypto (native binding loader).
        // In the renderer the database is accessed via the IPC bridge
        // (@nookdb/electron/renderer), not directly — but the schema DSL
        // (s.*) and connectNook transitively import nookdb. Externalizing
        // keeps nookdb as a Node.js require() call, which works in
        // Electron renderer when sandbox:false.
        external: ['nookdb'],
      },
    },
    plugins: [react()],
  },
});
