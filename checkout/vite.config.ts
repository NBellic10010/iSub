import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

// HTTPS (basic-ssl) so the embedding page is a secure context — and so the iframe to the iSub
// checkout host (also https) isn't a mixed-content block. Runs on :3001 (web is on :3000).
// Multi-page: the generic Acme demo (index) + two branded merchant demos (afterdark, citygrid).
// In dev each is served by path (/afterdark.html, /citygrid.html); the inputs make `build` include them.
export default defineConfig({
  plugins: [basicSsl()],
  server: { port: 3001 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        afterdark: resolve(import.meta.dirname, 'afterdark.html'),
        citygrid: resolve(import.meta.dirname, 'citygrid.html'),
        cortex: resolve(import.meta.dirname, 'cortex.html'),
      },
    },
  },
});
