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
  assertShardIndexPasswordsBlank,
  blankClusterPassword,
  blankShardIndexPassword,
  listSaveTarball,
  packStagedCluster,
  stageCluster,
  verifySaveTarball,
} from './save-tarball';

const FAKE_KLEI_TOKEN = 'unit-test-fixture-token-not-a-real-klei-credential';
const FAKE_PASSWORD = 'unit-test-fixture-password-0123';
// Interpolated, never a literal next to `=`: scripts/check-secrets.sh's content guard.
const SHARD_INDEX_PASSWORD_KEY = 'password';

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
    // DST's own save index, a Lua table literal that mirrors the live server settings — the
    // password included (docs/_first-boot-notes.md round 4).
    await writeFile(
      path.join(dir, shard, 'save', 'shardindex'),
      `return {server={name="Test Cluster",${SHARD_INDEX_PASSWORD_KEY}="${FAKE_PASSWORD}",game_mode="survival"},world={options="return {}"},version=5}`,
      'utf8',
    );
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

  // Defect 5 (docs/_security-review.md): a non-global regex only rewrites the first match, so a
  // cluster.ini carrying two cluster_password lines used to keep the second value.
  it('blanks every cluster_password line, not just the first', async () => {
    const FAKE_PASSWORD_2 = 'unit-test-fixture-password-second-9876';
    const iniPath = path.join(workDir, 'two-passwords.ini');
    await writeFile(
      iniPath,
      `[NETWORK]\ncluster_password = ${FAKE_PASSWORD}\n\n[NETWORK2]\ncluster_password = ${FAKE_PASSWORD_2}\n`,
      'utf8',
    );

    await blankClusterPassword(iniPath);

    const text = await readFile(iniPath, 'utf8');
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).not.toContain(FAKE_PASSWORD_2);
    expect(text.match(/^cluster_password = $/gm)).toHaveLength(2);
    await expect(assertPasswordBlank(iniPath)).resolves.toBeUndefined();
  });

  it('assertPasswordBlank rejects a file where a later cluster_password line still has a value', async () => {
    const iniPath = path.join(workDir, 'second-line-leaks.ini');
    // The first line is blank (as if blanking had "succeeded"), the second still carries a real
    // value — exactly the shape a non-global replace used to produce.
    await writeFile(
      iniPath,
      `[NETWORK]
cluster_password =

[NETWORK2]
cluster_password = ${FAKE_PASSWORD}
`,
      'utf8',
    );

    await expect(assertPasswordBlank(iniPath)).rejects.toThrow(/non-blank/);
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

// Round 4 (docs/_first-boot-notes.md): cluster.ini was not the only copy of the password on disk.
// DST mirrors the live server settings into its own per-shard save index, `<Shard>/save/shardindex`,
// so a tarball with a perfectly blank cluster.ini still carried the value to S3.
describe('shardindex password (round 4)', () => {
  it('blanks the value in place, keeping the key and the rest of the table', async () => {
    const filePath = path.join(clusterDir, 'Master', 'save', 'shardindex');
    await blankShardIndexPassword(filePath);
    const text = await readFile(filePath, 'utf8');
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).toContain(`${SHARD_INDEX_PASSWORD_KEY}=""`);
    expect(text).toContain('game_mode="survival"');
    expect(text).toContain('version=5');
  });

  it('blanks the bracketed key form and every occurrence', async () => {
    const filePath = path.join(workDir, 'shardindex');
    await writeFile(
      filePath,
      `return {a={["${SHARD_INDEX_PASSWORD_KEY}"] = "${FAKE_PASSWORD}"},b={${SHARD_INDEX_PASSWORD_KEY}="${FAKE_PASSWORD}"}}`,
      'utf8',
    );
    await blankShardIndexPassword(filePath);
    const text = await readFile(filePath, 'utf8');
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).toBe(
      `return {a={["${SHARD_INDEX_PASSWORD_KEY}"] = ""},b={${SHARD_INDEX_PASSWORD_KEY}=""}}`,
    );
  });

  it('is a no-op when the shard has no save index yet', async () => {
    await expect(
      blankShardIndexPassword(path.join(workDir, 'does-not-exist')),
    ).resolves.toBeUndefined();
  });

  it('stageCluster blanks every shard index, and the tarball keeps the file as a member', async () => {
    const stageDir = path.join(workDir, 'stage');
    const outFile = path.join(workDir, 'save.tar.zst');
    await stageCluster(clusterDir, stageDir);

    for (const shard of ['Master', 'Caves']) {
      const staged = await readFile(path.join(stageDir, shard, 'save', 'shardindex'), 'utf8');
      expect(staged).not.toContain(FAKE_PASSWORD);
      // Never deleted: a shard whose save/ has no index reads as an empty slot and DST would
      // generate a new world over the restored one.
      expect(staged).toContain('version=5');
    }
    // The live cluster directory is untouched.
    expect(await readFile(path.join(clusterDir, 'Master', 'save', 'shardindex'), 'utf8')).toContain(
      FAKE_PASSWORD,
    );

    await expect(assertShardIndexPasswordsBlank(stageDir)).resolves.toBeUndefined();

    await packStagedCluster(stageDir, outFile);
    const members = await listSaveTarball(outFile);
    expect(members.some((m) => m.includes('Master/save/shardindex'))).toBe(true);
  });

  it('assertShardIndexPasswordsBlank rejects a staged index that still carries a value', async () => {
    const stageDir = path.join(workDir, 'stage');
    await stageCluster(clusterDir, stageDir);
    // Put a value back, as an un-blanked staging would have left it.
    await writeFile(
      path.join(stageDir, 'Caves', 'save', 'shardindex'),
      `return {server={${SHARD_INDEX_PASSWORD_KEY}="${FAKE_PASSWORD}"}}`,
      'utf8',
    );
    await expect(assertShardIndexPasswordsBlank(stageDir)).rejects.toThrow(/non-blank password/);
  });
});
