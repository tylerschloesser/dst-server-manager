// The one bundler for @dst/supervisor (docs/decisions.md §16.29, docs/game-server.md §11):
// bundles the on-instance entrypoint to CommonJS with the four AWS SDK v3 clients included, no
// `--external` — the instance never runs an install. Then stages exactly what
// `DstGame`'s `BucketDeployment` reads: `dist/runtime/{supervisor.js, install.sh, bin/*,
// systemd/*, VERSION}` (`destinationKeyPrefix: 'runtime'`, `prune: true`).
import { execSync } from 'node:child_process';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/supervisor.js',
  sourcemap: 'inline',
  logLevel: 'info',
});

// `packages/supervisor/package.json` declares `"type": "module"` (so `tsx`/Vitest resolve the
// `exports` map as ESM source), but esbuild's CJS output uses `require`/`module.exports`. This
// one-line package.json makes `dist/` its own CommonJS scope — the same fix `@dst/api`'s
// `esbuild.mjs` applies to `dist/lambda/`.
await writeFile('dist/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');

// --- stage dist/runtime/ (docs/game-server.md §11) ---------------------------------------------
const runtimeDir = 'dist/runtime';
await mkdir(`${runtimeDir}/bin`, { recursive: true });
await mkdir(`${runtimeDir}/systemd`, { recursive: true });

await cp('dist/supervisor.js', `${runtimeDir}/supervisor.js`);
await cp('assets/install.sh', `${runtimeDir}/install.sh`);

for (const name of await readdir('assets/bin')) {
  await cp(`assets/bin/${name}`, `${runtimeDir}/bin/${name}`);
}
for (const name of await readdir('assets/systemd')) {
  await cp(`assets/systemd/${name}`, `${runtimeDir}/systemd/${name}`);
}

// The supervisor's first log line is `runtime VERSION=<sha>` (docs/game-server.md §11) — the git
// sha lets `sessions/*/supervisor.log` be matched back to the exact code that ran. `HEAD` when a
// sha cannot be resolved (e.g. a shallow checkout in some CI contexts) rather than failing the
// build over a cosmetic value.
let version = 'unknown';
try {
  version = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch {
  // no git metadata available; VERSION stays 'unknown'.
}
await writeFile(`${runtimeDir}/VERSION`, `${version}\n`);
