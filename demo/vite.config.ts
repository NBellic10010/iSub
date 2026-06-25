import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';

// The demo consumes the SDK's TypeScript source directly (no build step) via an alias.
// Only the core barrel is used in the browser — it's isomorphic (no node: imports);
// the node-only subpaths (@isubpay/sdk/store-file, /webhook) are never imported here.
export default defineConfig({
  // Sui wallets (Slush etc.) require a SECURE CONTEXT to connect — http://localhost is
  // rejected as "connection not secure". basicSsl() serves dev over https with a
  // self-signed cert (the browser warns once → "Advanced → proceed"; the origin is then
  // a secure context, so the wallet connects).
  plugins: [react(), basicSsl()],
  resolve: {
    alias: {
      '@isubpay/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
    },
    // CRITICAL: collapse to a single @mysten/sui (and React) copy across BOTH the demo
    // and the aliased SDK source. Without this, a `Transaction` built inside the SDK
    // comes from a different module instance than the one dApp-kit's signer expects,
    // and signing fails with confusing "not a Transaction" errors.
    dedupe: ['@mysten/sui', '@mysten/dapp-kit-react', 'react', 'react-dom'],
  },
});
