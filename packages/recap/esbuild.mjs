// Bundles the digest Lambda (docs/infra.md): one CommonJS file, AWS SDK and the Anthropic SDK
// included, nothing external — the same rule as packages/api/esbuild.mjs (decisions §16.29).
// wasmoon loads its Lua VM from `glue.wasm`, which cannot be inlined into the JS; it is copied next
// to `digest.js` and the handler points wasmoon at it (`configureLuaWasm`).
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const outdir = 'dist/lambda';

await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['src/handlers/digest.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir,
  sourcemap: false,
  logLevel: 'info',
});

const wasm = path.join(path.dirname(require.resolve('wasmoon')), 'glue.wasm');
await copyFile(wasm, path.join(outdir, 'glue.wasm'));
// See packages/api/esbuild.mjs: makes dist/lambda/ its own CommonJS scope.
await writeFile(path.join(outdir, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
