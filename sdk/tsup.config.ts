import { defineConfig } from 'tsup';

// Builds the publishable @isubpay/sdk: one ESM bundle + .d.ts per public export entry.
// Shared internal modules are emitted as chunks (splitting). Runtime deps (@mysten/sui,
// @modelcontextprotocol/sdk) and node: builtins stay EXTERNAL — consumers install/provide them.
// (scripts/ is intentionally excluded — those are runnable tooling, not part of the library.)
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agent.ts',
    'src/biller.ts',
    'src/service.ts',
    'src/webhook.ts',
    'src/store-file.ts',
    'src/db.ts',
    'src/sql-store.ts',
    'src/gateway.ts',
    'src/relations.ts',
    'src/discovery.ts',
    'src/client-sdk.ts',
    'src/mcp.ts',
    'src/x402.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  target: 'node22',
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
