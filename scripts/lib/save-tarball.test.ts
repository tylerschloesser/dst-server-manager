// Fixtures are generated at test time in a temp directory and deleted afterwards (decisions
// §16.35): `.gitignore` and `scripts/check-secrets.sh` forbid tracking `cluster.ini` or
// `cluster_token.txt`, so nothing here is ever written to a committed path. The password line
// below uses a `${...}` interpolation so the literal source text is never a real-looking value
// (scripts/check-secrets.sh's own content-pattern guard).
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPasswordBlank,
  blankClusterPassword,
  listSaveTarball,
  packStagedCluster,
  stageCluster,
  verifySaveTarball,
} from './save-tarball';

const FAKE_KLEI_TOKEN = 'unit-test-fixture-token-not-a-real-klei-credential';
const FAKE_PASSWORD = 'unit-test-fixture-password-0123';

let workDir: string;
let clusterDir: string;

async function buildFakeCluster(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'cluster.ini'),
    `[GAMEPLAY]\nmax_players = 6\n\n[NETWORK]\ncluster_name = Test Cluster\ncluster_password = ${FAKE_PASSWORD}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'cluster_token.txt'), FAKE_KLEI_TOKEN, 'utf8');

  for (const shard of ['Master', 'Caves']) {
    await mkdir(path.join(dir, shard, 'save', 'server_temp'), { recursive: true });
    await mkdir(path.join(dir, shard, 'save', 'client_temp'), { recursive: true });
    await mkdir(path.join(dir, shard, 'save', 'cached_userid'), { recursive: true });
    await mkdir(path.join(dir, shard, 'save', 'session', 'abc123'), { recursive: true });
    await writeFile(path.join(dir, shard, 'save', 'server_temp', 'x'), 'scratch', 'utf8');
    await writeFile(path.join(dir, shard, 'save', 'session', 'abc123', 'save.dat'), 'keep', 'utf8');
    await writeFile(path.join(dir, shard, 'server_log.txt'), 'log churn', 'utf8');
    await writeFile(path.join(dir, shard, 'server_chat_log.txt'), 'chat churn', 'utf8');
    await mkdir(path.join(dir, shard, 'backup', 'server_log'), { recursive: true });
    await writeFile(path.join(dir, shard, 'backup', 'server_log', 'old.txt'), 'old', 'utf8');
    await writeFile(path.join(dir, shard, 'server.ini'), '[SHARD]\nis_master = true\n', 'utf8');
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dst-save-tarball-test-'));
  clusterDir = path.join(workDir, 'cluster');
  await buildFakeCluster(clusterDir);
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workDir, { recursive: true, force: true });
});

describe('blankClusterPassword', () => {
  it('replaces the value but keeps the key and the line', async () => {
    const iniPath = path.join(clusterDir, 'cluster.ini');
    await blankClusterPassword(iniPath);
    const text = await readFile(iniPath, 'utf8');
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).toMatch(/^cluster_password = $/m);
    await expect(assertPasswordBlank(iniPath)).resolves.toBeUndefined();
  });

  it('throws when cluster.ini has no cluster_password line', async () => {
    const iniPath = path.join(workDir, 'no-password.ini');
    await writeFile(iniPath, '[NETWORK]\ncluster_name = X\n', 'utf8');
    await expect(blankClusterPassword(iniPath)).rejects.toThrow();
  });
});

describe('stageCluster + packStagedCluster (tarball sanitising)', () => {
  it('drops cluster_token.txt and blanks the password in the staged copy, never the source', async () => {
    const stageDir = path.join(workDir, 'stage');
    await stageCluster(clusterDir, stageDir);

    await expect(readFile(path.join(stageDir, 'cluster_token.txt'), 'utf8')).rejects.toThrow();
    // The original cluster directory is never mutated — stageCluster only ever reads it.
    const originalIni = await readFile(path.join(clusterDir, 'cluster.ini'), 'utf8');
    expect(originalIni).toContain(FAKE_PASSWORD);

    await assertPasswordBlank(path.join(stageDir, 'cluster.ini'));
  });

  it('excludes save scratch, log churn and backup from the tar member set, keeping the session snapshot', async () => {
    const stageDir = path.join(workDir, 'stage');
    const outFile = path.join(workDir, 'save.tar.zst');
    await stageCluster(clusterDir, stageDir);
    await packStagedCluster(stageDir, outFile);

    const members = await listSaveTarball(outFile);
    for (const forbidden of [
      'cluster_token.txt',
      'Master/save/server_temp',
      'Master/save/client_temp',
      'Master/save/cached_userid',
      'Master/server_log.txt',
      'Master/server_chat_log.txt',
      'Master/backup',
    ]) {
      expect(members.some((m) => m.includes(forbidden))).toBe(false);
    }
    expect(members.some((m) => m.includes('Master/save/session/abc123/save.dat'))).toBe(true);
    expect(members.some((m) => m.includes('cluster.ini'))).toBe(true);

    await expect(verifySaveTarball(outFile)).resolves.toBeUndefined();
  });

  it('archives the cluster contents at the archive root, no wrapper directory (decisions §16.22)', async () => {
    const stageDir = path.join(workDir, 'stage');
    const outFile = path.join(workDir, 'save.tar.zst');
    await stageCluster(clusterDir, stageDir);
    await packStagedCluster(stageDir, outFile);

    const members = await listSaveTarball(outFile);
    expect(members.some((m) => m === 'cluster.ini' || m === './cluster.ini')).toBe(true);
    expect(members.every((m) => !m.startsWith('stage/') && !m.startsWith('cluster/'))).toBe(true);
  });

  it('verifySaveTarball throws when a forbidden member is present', async () => {
    // Pack the RAW (unstaged) cluster directly, skipping the exclude list entirely, to prove the
    // verifier actually catches a bad tarball rather than always passing.
    const outFile = path.join(workDir, 'unsafe.tar.zst');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('tar', ['--zstd', '-c', '-f', outFile, '-C', clusterDir, '.']);
    await expect(verifySaveTarball(outFile)).rejects.toThrow(/forbidden member/);
  });
});
