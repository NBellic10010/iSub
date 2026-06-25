// Generate the PUBLISHED package manifest into dist/ (run after tsup).
//
// The workspace root sdk/package.json keeps `exports` pointing at ./src/*.ts so the monorepo
// (web/checkout/demo) and `next dev` keep consuming TypeScript SOURCE unchanged — zero risk to the
// live app. The PUBLISHED package is the self-contained dist/ folder: this script writes a
// dist/package.json whose exports point at the compiled ./*.js + ./*.d.ts, and copies README + LICENSE.
// Publish with:  npm publish ./dist --access public   (see the `release` script).
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const here = (p) => new URL(p, import.meta.url);
const root = JSON.parse(readFileSync(here('../package.json'), 'utf8'));

// src exports → dist exports: "./client": "./src/client-sdk.ts" → { types: "./client-sdk.d.ts", import: "./client-sdk.js" }
const exportsMap = {};
for (const [key, srcPath] of Object.entries(root.exports)) {
  const base = basename(String(srcPath)).replace(/\.ts$/, '');
  exportsMap[key] = { types: `./${base}.d.ts`, import: `./${base}.js` };
}

const pkg = {
  name: root.name,
  version: root.version,
  description: root.description,
  license: root.license,
  homepage: root.homepage,
  repository: root.repository,
  keywords: root.keywords,
  type: 'module',
  engines: root.engines,
  publishConfig: { access: 'public' },
  main: './index.js',
  types: './index.d.ts',
  exports: exportsMap,
  dependencies: root.dependencies,
};

writeFileSync(here('../dist/package.json'), JSON.stringify(pkg, null, 2) + '\n');
for (const f of ['README.md', 'LICENSE']) {
  if (existsSync(here(`../${f}`))) copyFileSync(here(`../${f}`), here(`../dist/${f}`));
}
console.log(`✓ dist/package.json written — ${pkg.name}@${pkg.version} (${Object.keys(exportsMap).length} export entries) + README + LICENSE`);
