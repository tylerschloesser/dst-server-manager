// The ONE save-tarball command (docs/storage.md §6, decisions §16.36): stage a copy of the
// cluster directory, blank the password in the staged cluster.ini, then run exactly this tar
// command over the staging directory. `packages/supervisor/assets/bin/dst-pack-save` is the
// on-instance implementation of the identical spec; `packages/supervisor` is not a workspace
// dependency of the root package (docs/testing.md §1.0), so `scripts/import-world.ts` is a second,
// independent implementation of the same command and exclude list, not shared code — exactly what
// the doc describes ("both stage a copy ... and run exactly this command").
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The key name goes through a variable on purpose (docs/storage.md §6): check-secrets.sh blocks
// any tracked line where this key is followed by a real-looking value, so it must never appear as
// a string literal next to `=` in this source file.
const PASSWORD_KEY = 'cluster_password';

/** docs/storage.md §6's exact exclude list. */
export const SAVE_TARBALL_EXCLUDES: readonly string[] = [
  'cluster_token.txt',
  '*/save/server_temp',
  '*/save/client_temp',
  '*/save/cached_userid',
  '*/server_log.txt',
  '*/server_chat_log.txt',
  '*/backup',
];

/** Blanks the `cluster_password` line in place — key, `=`, end of line — so the value never
 * reaches the staged copy (docs/storage.md §6). A missing `cluster.ini` is the caller's problem,
 * not this function's: it throws (ENOENT) rather than silently doing nothing. */
export async function blankClusterPassword(iniPath: string): Promise<void> {
  const text = await readFile(iniPath, 'utf8');
  const re = new RegExp(`^([ \\t]*${PASSWORD_KEY}[ \\t]*=).*$`, 'm');
  if (!re.test(text)) {
    throw new Error(`no ${PASSWORD_KEY} line found in ${iniPath}`);
  }
  await writeFile(iniPath, text.replace(re, '$1 '), 'utf8');
}

/** docs/storage.md §7 step 5 / docs/storage.md §6: stages a sanitised copy of `clusterDir` into
 * `stageDir` — drops `cluster_token.txt`, blanks the password, and removes the three per-instance
 * `save/*` scratch entries under every top-level shard directory (`Master/`, `Caves/`, ...). */
export async function stageCluster(clusterDir: string, stageDir: string): Promise<void> {
  await mkdir(stageDir, { recursive: true });
  await cp(clusterDir, stageDir, { recursive: true });

  await rm(path.join(stageDir, 'cluster_token.txt'), { force: true });
  await blankClusterPassword(path.join(stageDir, 'cluster.ini'));

  const entries = await readdir(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const scratch of ['server_temp', 'client_temp', 'cached_userid']) {
      await rm(path.join(stageDir, entry.name, 'save', scratch), {
        recursive: true,
        force: true,
      });
    }
  }
}

/** Runs the single tar command of docs/storage.md §6 over an already-staged directory. */
export async function packStagedCluster(stageDir: string, outFile: string): Promise<void> {
  const args = [
    '--zstd',
    '-c',
    '-f',
    outFile,
    '-C',
    stageDir,
    ...SAVE_TARBALL_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    '.',
  ];
  await execFileAsync('tar', args, {
    env: { ...process.env, ZSTD_CLEVEL: '3', ZSTD_NBTHREADS: '0' },
  });
}

/** Lists the tarball's member paths (`tar --zstd -tf`). */
export async function listSaveTarball(tarFile: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['--zstd', '-tf', tarFile]);
  return stdout.split('\n').filter((line) => line.length > 0);
}

const FORBIDDEN_MEMBER_RE = /cluster_token|server_temp|client_temp|cached_userid/;

/** docs/storage.md §7 step 7: this must print nothing. Throws with the offending member name
 * (never the tarball's byte content) if the exclude list failed to keep something out. */
export async function verifySaveTarball(tarFile: string): Promise<void> {
  const members = await listSaveTarball(tarFile);
  const hit = members.find((m) => FORBIDDEN_MEMBER_RE.test(m));
  if (hit !== undefined) {
    throw new Error(`save tarball contains a forbidden member: ${hit}`);
  }
}

/** docs/storage.md §7 step 7: "assert with grep -c (never echo) that the staged password line
 * carries no value." */
export async function assertPasswordBlank(iniPath: string): Promise<void> {
  const text = await readFile(iniPath, 'utf8');
  const re = new RegExp(`^[ \\t]*${PASSWORD_KEY}[ \\t]*=[ \\t]*$`, 'm');
  if (!re.test(text)) {
    throw new Error('staged cluster.ini password line is not blank');
  }
}
