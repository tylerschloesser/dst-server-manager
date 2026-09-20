// The one bundler for @dst/api (docs/decisions.md §16.29): bundles the two Lambda entry files to
// CommonJS, AWS SDK included, nothing external. This is exactly what CDK deploys
// (`Code.fromAsset(apiBundlePath)`), so what is tested (`src/handlers/*.ts`) is what ships.
import { writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

const entries = ['src/handlers/api.ts', 'src/handlers/reaper.ts'];

await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist/lambda',
  sourcemap: false,
  logLevel: 'info',
});

// `packages/api/package.json` declares `"type": "module"` (so `tsx`/Vitest resolve the `exports`
// map as ESM source), but esbuild's CJS output uses `require`/`module.exports`. Without this file,
// Node resolves `dist/lambda/*.js`'s module type from the nearest ancestor package.json (the ESM
// one) and refuses to load it as CommonJS. This one-line package.json makes `dist/lambda/` its own
// CommonJS scope, matching the AWS Lambda Node 22 runtime, which loads `api.handler` via `require`.
await writeFile('dist/lambda/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');
