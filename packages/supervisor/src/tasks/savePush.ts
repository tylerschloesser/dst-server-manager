// @dst/supervisor tasks: the save tarball, packed and pushed (docs/game-server.md §10,
// docs/storage.md §6). The tar command and its exclude list live in exactly one place —
// `assets/bin/dst-pack-save` — which this task shells out to; it never re-implements the command.
// Uploaded with `ObjectPort.putObject` (the SDK), so `VersionId` comes back.
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { ObjectPort } from '../core';

const execFileAsync = promisify(execFile);
const PACK_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_BACKOFF_MS = [1_000, 2_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < UPLOAD_ATTEMPTS - 1) {
        await sleep(UPLOAD_BACKOFF_MS[attempt] ?? 4_000);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('upload failed after retries');
}

export interface PackAndPushSaveInput {
  readonly clusterDir: string;
  readonly outPath: string;
  /** `worlds/<worldId>/save.tar.zst` on the stop path, `inflight/<worldId>/save.tar.zst` for the
   *  10-minute in-session safety copy (docs/game-server.md §8, §10). */
  readonly key: string;
  readonly objects: ObjectPort;
  /** `true` for the in-session safety copy: `nice -n 19 ionice -c3` so it never competes with a
   *  live session (docs/game-server.md §8). The stop-path push runs at normal priority. */
  readonly lowPriority?: boolean;
}

export interface PackAndPushSaveResult {
  readonly versionId: string | null;
}

/** `dst-pack-save <clusterDir> <out.tar.zst>` (docs/game-server.md §10): stages a copy of the
 *  cluster directory, blanks the password, tars with the single §6 exclude list — safe to run
 *  while the shards are running (inflight copies never mutate the live cluster). */
export async function packAndPushSave(input: PackAndPushSaveInput): Promise<PackAndPushSaveResult> {
  const command = input.lowPriority === true ? 'nice' : '/usr/local/bin/dst-pack-save';
  const args =
    input.lowPriority === true
      ? [
          '-n',
          '19',
          'ionice',
          '-c3',
          '/usr/local/bin/dst-pack-save',
          input.clusterDir,
          input.outPath,
        ]
      : [input.clusterDir, input.outPath];

  await execFileAsync(command, args, { timeout: PACK_TIMEOUT_MS });

  const body = await readFile(input.outPath);
  try {
    return await withRetries(() => input.objects.putObject(input.key, body));
  } finally {
    await unlink(input.outPath).catch(() => undefined);
  }
}
