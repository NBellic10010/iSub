import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS (basic-ssl) so the embedding page is a secure context — and so the iframe to the iSub
// checkout host (also https) isn't a mixed-content block. Runs on :3001 (web is on :3000).
export default defineConfig({
  plugins: [basicSsl()],
  server: { port: 3001 },
});
