import type { NextConfig } from 'next';
import path from 'node:path';

// @isubpay/sdk ships TypeScript source (exports point at ./src/*.ts), so Next must transpile it.
// Because the repo is one npm workspace, @mysten/sui + react hoist to a single copy — no alias
// dedupe needed (a Transaction built inside the SDK is the same branded type dApp-kit signs).
// Same-origin proxy to the iSub gateway. The browser calls /gw/* (same origin as the page, so it
// works over the dev server's HTTPS with no mixed-content block and no CORS); Next forwards it to the
// gateway server-side. Override the target with GATEWAY_ORIGIN.
const GATEWAY_ORIGIN = process.env.GATEWAY_ORIGIN || 'http://localhost:4100';

const nextConfig: NextConfig = {
  transpilePackages: ['@isubpay/sdk'],
  // Pin the workspace root (a stray lockfile in $HOME otherwise confuses Next's inference).
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  async rewrites() {
    return [{ source: '/gw/:path*', destination: `${GATEWAY_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
