// Regression test for docs/_security-review.md defect 1: a supervisor resumed after a crash
// (`Restart=on-failure`, docs/game-server.md §8 "Crash handling") never runs `restoreOrGenerateWorld`
// (`tasks/restore.ts`), so the only two `.reveal()` call sites in the whole codebase are never hit
// in that process. Deriving the upload-time scrub list from `Secret.reveal()`'s process-lifetime
// side effect (`adapters/secret.ts`'s `revealedSecretValues()`) therefore left a resumed session
// uploading `sessions/<worldId>/<sessionId>/` logs to S3 completely unscrubbed. This test proves
// `resolveSecretsToScrub` + `uploadSessionLogs` scrub both secret values out of every uploaded file
// even when nothing in this process has ever called `.reveal()` before — i.e. even on the resume
// path, with no restore. No AWS, no network (`vitest.setup.ts` blocks it) — a fake `ObjectPort`
// captures upload bodies and a real cluster directory is built under `mkdtemp`, deleted afterwards
// (decisions §16.35: no save-shaped fixture is ever committed).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecret } from '../adapters/secret';
import type { ObjectPort, Secret, SecretPort, SessionManifest } from '../core';
import { resolveSecretsToScrub, uploadSessionLogs } from './logsUpload';

// Distinctive, never used by any other test in this suite, so this test cannot pass by accident
// because some *other* test already called `.reveal()` on the same string (`revealedSecretValues()`
// backs a module-level `Set` shared by the whole process, docs/game-server.md §10).
const FAKE_KLEI_TOKEN = 'logsupload-test-fixture-klei-token-14a9c2';
const FAKE_CLUSTER_PASSWORD = 'logsupload-test-fixture-password-77e0b1';

function fakeSecretPort(): SecretPort {
  const password: Secret = createSecret(FAKE_CLUSTER_PASSWORD);
  const token: Secret = createSecret(FAKE_KLEI_TOKEN);
  return {
    getClusterPassword: () => Promise.resolve(password),
    getKleiToken: () => Promise.resolve(token),
  };
}

function fakeObjectPort(): ObjectPort & { readonly puts: Map<string, Buffer> } {
  const puts = new Map<string, Buffer>();
  return {
    puts,
    getObject: () => Promise.resolve(null),
    putObject: (key, body) => {
      puts.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body as never));
      return Promise.resolve({ versionId: null });
    },
  };
}

function fakeManifest(): SessionManifest {
  return {
    sessionId: '20260919T201355Z-a1b2c3',
    worldId: 'test-logsupload',
    startedBy: 'nickname',
    startedAt: '2026-09-19T20:13:04.000Z',
    joinableAt: '2026-09-19T20:15:49.000Z',
    stoppedAt: '2026-09-19T22:41:10.000Z',
    stopReason: 'idle',
    peakPlayers: 1,
    instanceType: 'c6i.large',
    dstBuildId: '24700372',
    preStartVersionId: null,
    postStopVersionId: null,
  };
}

let clusterDir: string;
let supervisorLogPath: string;

beforeEach(async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'dst-logsupload-test-'));
  clusterDir = path.join(workDir, 'cluster');
  await mkdir(path.join(clusterDir, 'Master'), { recursive: true });
  await mkdir(path.join(clusterDir, 'Caves'), { recursive: true });

  // Server logs that would, in the real bug, carry the secret straight through to S3 — e.g. a
  // console echo or an admin pasting a connect string into chat.
  await writeFile(
    path.join(clusterDir, 'Master', 'server_log.txt'),
    `[00:00:01]: booting\n[00:00:02]: token=${FAKE_KLEI_TOKEN}\n[00:00:03]: joinable\n`,
    'utf8',
  );
  await writeFile(
    path.join(clusterDir, 'Master', 'server_chat_log.txt'),
    `[chat] someone pasted the password: ${FAKE_CLUSTER_PASSWORD}\n`,
    'utf8',
  );
  await writeFile(
    path.join(clusterDir, 'Caves', 'server_log.txt'),
    '[00:00:01]: caves up\n',
    'utf8',
  );
  await writeFile(path.join(clusterDir, 'Caves', 'server_chat_log.txt'), '', 'utf8');

  supervisorLogPath = path.join(workDir, 'supervisor.log');
  await writeFile(
    supervisorLogPath,
    `{"event":"cluster_password_written"}\n{"event":"leaked","value":"${FAKE_CLUSTER_PASSWORD}"}\n{"event":"klei_token_written","value":"${FAKE_KLEI_TOKEN}"}\n`,
    'utf8',
  );
});

afterEach(async () => {
  await rm(path.dirname(clusterDir), { recursive: true, force: true });
});

describe('resolveSecretsToScrub + uploadSessionLogs (resumed session, no restore this process)', () => {
  it('scrubs both secret values from every uploaded file even though nothing in this process ever called .reveal() before now', async () => {
    // Simulates the crash-resume branch exactly (docs/game-server.md §8): `restoreOrGenerateWorld`
    // — the only other place in the codebase that calls `.reveal()` — is never invoked here.
    const secrets = fakeSecretPort();
    const objects = fakeObjectPort();

    const secretsToScrub = await resolveSecretsToScrub(secrets);
    expect(secretsToScrub).toEqual(
      expect.arrayContaining([FAKE_CLUSTER_PASSWORD, FAKE_KLEI_TOKEN]),
    );

    await uploadSessionLogs({
      worldId: 'test-logsupload',
      sessionId: '20260919T201355Z-a1b2c3',
      hasCaves: true,
      clusterDir,
      supervisorLogPath,
      secretsToScrub,
      manifest: fakeManifest(),
      objects,
    });

    expect(objects.puts.size).toBeGreaterThan(0);
    for (const [key, body] of objects.puts) {
      const text = body.toString('utf8');
      expect(text, `${key} must not contain the cluster password`).not.toContain(
        FAKE_CLUSTER_PASSWORD,
      );
      expect(text, `${key} must not contain the Klei token`).not.toContain(FAKE_KLEI_TOKEN);
    }

    const chatBody = objects.puts.get(
      'sessions/test-logsupload/20260919T201355Z-a1b2c3/master/server_chat_log.txt',
    );
    expect(chatBody?.toString('utf8')).toContain('*** REDACTED ***');
    const supervisorBody = objects.puts.get(
      'sessions/test-logsupload/20260919T201355Z-a1b2c3/supervisor.log',
    );
    expect(supervisorBody?.toString('utf8')).toContain('*** REDACTED ***');
  });
});
