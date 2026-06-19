import type { NextConfig } from 'next';
import path from 'node:path';

// @isub/sdk ships TypeScript source (exports point at ./src/*.ts), so Next must transpile it.
// Because the repo is one npm workspace, @mysten/sui + react hoist to a single copy — no alias
// dedupe needed (a Transaction built inside the SDK is the same branded type dApp-kit signs).
const nextConfig: NextConfig = {
  transpilePackages: ['@isub/sdk'],
  // Pin the workspace root (a stray lockfile in $HOME otherwise confuses Next's inference).
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
};

export default nextConfig;
