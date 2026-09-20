// @dst/supervisor tasks: DST binaries (docs/game-server.md §4). Owned by the supervisor, not
// user-data, so it can change without a new launch template. The streamed warm-restore / cold
// steamcmd-install pipe work is delegated to `assets/bin/dst-install-binaries` (a shell pipeline
// is the natural way to do "never touch disk"); this module does the parts that need the AWS SDK
// or TypeScript: the build-id compare and, once joinable, kicking off the detached repack.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { parseBuildId } from '../core';
import type { ObjectPort } from '../core';
import type { Logger } from '../adapters/logger';

const execFileAsync = promisify(execFile);

export interface InstallBinariesInput {
  readonly bucket: string;
  readonly region: string;
  readonly dstRoot: string;
  readonly objects: ObjectPort;
  readonly logger: Logger;
}

export interface InstallBinariesResult {
  readonly dstBuildId: string;
  /** `true` when the installed build differs from (or there was no) `binaries/buildid` — the
   *  tarball must be re-packed once the world is joinable (docs/game-server.md §4 step 3). */
  readonly repackNeeded: boolean;
}

function acfPath(dstRoot: string): string {
  return `${dstRoot}/server/steamapps/appmanifest_343050.acf`;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** docs/game-server.md §4 steps 1-4: warm streamed restore (no `validate`) or cold install
 *  (`validate`), then the build-id compare against `binaries/buildid`. A failure here is fatal
 *  (the caller writes `lastError` and stops with reason `crash`). */
export async function installBinaries(input: InstallBinariesInput): Promise<InstallBinariesResult> {
  const { bucket, region, dstRoot, objects, logger } = input;

  await execFileAsync('/usr/local/bin/dst-install-binaries', [], {
    env: { ...process.env, DST_BUCKET: bucket, DST_REGION: region, DST_ROOT: dstRoot },
    maxBuffer: 32 * 1024 * 1024,
  });

  const acf = await readFile(acfPath(dstRoot), 'utf8');
  const dstBuildId = parseBuildId(acf);
  if (dstBuildId === null) {
    throw new Error('installBinaries: could not parse buildid from appmanifest_343050.acf');
  }

  const existing = await objects.getObject('binaries/buildid');
  let repackNeeded: boolean;
  if (existing === null) {
    repackNeeded = true;
  } else {
    const previousBuildId = (await streamToString(existing.body)).trim();
    repackNeeded = previousBuildId !== dstBuildId;
  }

  logger.info('binaries_installed', { dstBuildId, repackNeeded });
  return { dstBuildId, repackNeeded };
}

/** docs/game-server.md §4 step 5: detached, best-effort, `nice`/`ionice`, only once the world is
 *  joinable, never blocking the loop. Tarball uploaded before `binaries/buildid` is updated, so a
 *  crash mid-repack can never leave a `buildid` newer than the tarball it describes. */
export function repackBinariesInBackground(input: InstallBinariesInput): void {
  const { bucket, region, dstRoot, logger } = input;
  const child = spawn('/usr/local/bin/dst-pack-binaries', [], {
    env: { ...process.env, DST_BUCKET: bucket, DST_REGION: region, DST_ROOT: dstRoot },
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => logger.warn('repack_binaries_spawn_failed', { error: String(err) }));
  child.unref();
}
