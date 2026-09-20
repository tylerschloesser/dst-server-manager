// @dst/supervisor tasks: world restore and generation, plus secret injection
// (docs/game-server.md §5). `preStartVersionId` is captured from the S3 `GetObject` response;
// `NoSuchKey` means generate instead (registry `source` is `generated`/`test` — v1 uses this path
// only for `test-*` worlds). Every enforcement step in "Enforced every boot, restored or
// generated" runs regardless of which path was taken.
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { CAVES_SHARD_ID } from '@dst/shared';

import {
  buildGeneratedClusterFiles,
  enforceCavesShardId,
  enforceClusterName,
  enforceClusterPassword,
  enforceConsoleEnabled,
  readPauseWhenEmpty,
} from '../core';
import type { ObjectPort, SecretPort } from '../core';
import type { Logger } from '../adapters/logger';

const execFileAsync = promisify(execFile);

export interface RestoreWorldInput {
  readonly clusterDir: string;
  readonly worldId: string;
  readonly serverName: string;
  readonly hasCaves: boolean;
  readonly objects: ObjectPort;
  readonly secrets: SecretPort;
  readonly logger: Logger;
}

export interface RestoreWorldResult {
  readonly preStartVersionId: string | null;
  /** `false` once the pause cross-check should be disabled for the session
   *  (docs/game-server.md §7): `pause_when_empty` was not `true`, or absent. */
  readonly pauseWhenEmpty: boolean;
}

async function extractTarball(clusterDir: string, body: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-I', 'zstd', '-x', '-C', clusterDir, '--no-same-owner'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract exited with code ${code}`));
    });
    if (child.stdin === null) {
      reject(new Error('tar extract: child process has no stdin'));
      return;
    }
    body.pipe(child.stdin);
  });
}

async function writeGeneratedCluster(
  clusterDir: string,
  input: { serverName: string; hasCaves: boolean },
): Promise<void> {
  const clusterKey = randomBytes(16).toString('hex');
  const files = buildGeneratedClusterFiles({
    serverName: input.serverName,
    hasCaves: input.hasCaves,
    clusterKey,
  });
  for (const file of files) {
    const fullPath = `${clusterDir}/${file.path}`;
    const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, file.content, 'utf8');
  }
}

async function enforceClusterIni(
  clusterDir: string,
  serverName: string,
  password: string,
): Promise<boolean> {
  const path = `${clusterDir}/cluster.ini`;
  let content = await readFile(path, 'utf8');
  content = enforceConsoleEnabled(content);
  content = enforceClusterName(content, serverName);
  content = enforceClusterPassword(content, password);
  await writeFile(path, content, 'utf8');
  const pauseWhenEmpty = readPauseWhenEmpty(content);
  return pauseWhenEmpty === true;
}

async function enforceCavesServerIni(clusterDir: string): Promise<void> {
  const path = `${clusterDir}/Caves/server.ini`;
  const content = await readFile(path, 'utf8');
  await writeFile(path, enforceCavesShardId(content, CAVES_SHARD_ID), 'utf8');
}

/** `cluster_token.txt` = the Klei token, mode 0600, `dst:dst`. Never a save-tarball member
 *  (excluded in `assets/bin/dst-pack-save`) and never logged (docs/game-server.md §10). */
async function writeClusterToken(clusterDir: string, token: string): Promise<void> {
  const path = `${clusterDir}/cluster_token.txt`;
  await writeFile(path, token, { mode: 0o600 });
}

export async function restoreOrGenerateWorld(
  input: RestoreWorldInput,
): Promise<RestoreWorldResult> {
  const { clusterDir, worldId, serverName, hasCaves, objects, secrets, logger } = input;
  await mkdir(clusterDir, { recursive: true });

  const restored = await objects.getObject(`worlds/${worldId}/save.tar.zst`);
  let preStartVersionId: string | null;
  if (restored !== null) {
    await extractTarball(clusterDir, restored.body);
    preStartVersionId = restored.versionId;
    if (!hasCaves && existsSync(`${clusterDir}/Caves`)) {
      logger.warn('restored_caves_dir_with_hasCaves_false', { worldId });
    }
  } else {
    await writeGeneratedCluster(clusterDir, { serverName, hasCaves });
    preStartVersionId = null;
  }

  const password = (await secrets.getClusterPassword()).reveal();
  const pauseWhenEmpty = await enforceClusterIni(clusterDir, serverName, password);
  if (hasCaves) await enforceCavesServerIni(clusterDir);

  const token = (await secrets.getKleiToken()).reveal();
  await writeClusterToken(clusterDir, token);

  await execFileAsync('chown', ['-R', 'dst:dst', clusterDir]);

  if (!pauseWhenEmpty) {
    logger.warn('pause_when_empty_disabled', { worldId });
  }

  return { preStartVersionId, pauseWhenEmpty };
}

/** Reads `pause_when_empty` straight off the on-disk `cluster.ini` without touching anything
 *  (docs/game-server.md §7, §8) — used only when resuming a crashed supervisor into a session
 *  whose world was already restored/generated by the pre-crash process, so `restoreOrGenerateWorld`
 *  itself (which would re-extract the tarball over a live cluster directory) must not run again.
 *  `false` on any read error, matching `enforceClusterIni`'s "absent means disable the cross-check"
 *  rule (docs/game-server.md §7). */
export async function readPauseWhenEmptyFromDisk(clusterDir: string): Promise<boolean> {
  try {
    const content = await readFile(`${clusterDir}/cluster.ini`, 'utf8');
    return readPauseWhenEmpty(content) === true;
  } catch {
    return false;
  }
}
