// Unit tests for crash-recovery persistence (docs/game-server.md §8 "Crash handling"). No AWS, no
// shard processes — just the file and the pure decision logic around it. `vitest.setup.ts` blocks
// network access; everything here is local filesystem + pure functions.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSessionSnapshot,
  canResumeFrom,
  idleStateFromResumeInfo,
  isValidSessionSnapshot,
  readSessionSnapshot,
  sessionFilePath,
  toResumeInfo,
  writeSessionSnapshot,
  type SessionSnapshot,
} from './sessionFile';

function validSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    phase: 'running',
    worldId: 'test-a',
    sessionId: '20260919T201355Z-a1b2c3',
    startedAt: '2026-09-19T20:13:04.000Z',
    joinableAt: '2026-09-19T20:15:49.000Z',
    lastNonZeroAt: '2026-09-19T20:20:00.000Z',
    zeroStreak: 2,
    peakPlayers: 3,
    preStartVersionId: 'v1',
    dstBuildId: '24700372',
    ...overrides,
  };
}

describe('isValidSessionSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isValidSessionSnapshot(validSnapshot())).toBe(true);
  });

  it('accepts null joinableAt and null preStartVersionId (a generated, not-yet-joinable world)', () => {
    expect(
      isValidSessionSnapshot(validSnapshot({ joinableAt: null, preStartVersionId: null })),
    ).toBe(true);
  });

  it('rejects a missing field', () => {
    const snapshot: Record<string, unknown> = { ...validSnapshot() };
    delete snapshot['zeroStreak'];
    expect(isValidSessionSnapshot(snapshot)).toBe(false);
  });

  it('rejects a non-ISO startedAt', () => {
    expect(isValidSessionSnapshot(validSnapshot({ startedAt: 'not-a-date' }))).toBe(false);
  });

  it('rejects a negative zeroStreak', () => {
    expect(isValidSessionSnapshot(validSnapshot({ zeroStreak: -1 }))).toBe(false);
  });

  it('rejects an empty worldId or sessionId', () => {
    expect(isValidSessionSnapshot(validSnapshot({ worldId: '' }))).toBe(false);
    expect(isValidSessionSnapshot(validSnapshot({ sessionId: '' }))).toBe(false);
  });

  it('rejects null, a primitive and an array', () => {
    expect(isValidSessionSnapshot(null)).toBe(false);
    expect(isValidSessionSnapshot('session')).toBe(false);
    expect(isValidSessionSnapshot([])).toBe(false);
  });

  it('never contains the Klei token or the cluster password field names', () => {
    // The persisted shape is a closed, hand-written interface (docs/game-server.md §8's ten
    // fields) — this just pins that nobody widened it to carry a secret.
    expect(Object.keys(validSnapshot())).toEqual([
      'phase',
      'worldId',
      'sessionId',
      'startedAt',
      'joinableAt',
      'lastNonZeroAt',
      'zeroStreak',
      'peakPlayers',
      'preStartVersionId',
      'dstBuildId',
    ]);
  });
});

describe('toResumeInfo', () => {
  it('resumes from `starting`', () => {
    const resume = toResumeInfo(validSnapshot({ phase: 'starting', joinableAt: null }));
    expect(resume).not.toBeNull();
    expect(resume?.phase).toBe('starting');
    expect(resume?.joinableAt).toBeNull();
  });

  it('resumes from `running` and parses every ISO field to a Date', () => {
    const snapshot = validSnapshot();
    const resume = toResumeInfo(snapshot);
    expect(resume).toEqual({
      phase: 'running',
      startedAt: new Date(snapshot.startedAt),
      joinableAt: new Date(snapshot.joinableAt as string),
      lastNonZeroAt: new Date(snapshot.lastNonZeroAt),
      zeroStreak: snapshot.zeroStreak,
      peakPlayers: snapshot.peakPlayers,
      preStartVersionId: snapshot.preStartVersionId,
      dstBuildId: snapshot.dstBuildId,
    });
  });

  it('never resumes from installing, stopping, boot or halted — always cold-restart instead', () => {
    for (const phase of ['installing', 'stopping', 'boot', 'halted'] as const) {
      expect(toResumeInfo(validSnapshot({ phase }))).toBeNull();
    }
  });
});

describe('idleStateFromResumeInfo', () => {
  it('carries zeroStreak and lastNonZeroAt through, and always restarts unknownStreak at 0', () => {
    const resume = toResumeInfo(validSnapshot({ zeroStreak: 2 }));
    expect(resume).not.toBeNull();
    expect(idleStateFromResumeInfo(resume!)).toEqual({
      zeroStreak: 2,
      unknownStreak: 0,
      lastNonZeroAt: resume!.lastNonZeroAt,
    });
  });
});

describe('canResumeFrom', () => {
  const state = { sessionId: 'sid-1', instanceId: 'i-1', worldId: 'test-a' };

  it('resumes when the snapshot matches the state item and this instance exactly', () => {
    const snapshot = validSnapshot({ sessionId: 'sid-1', worldId: 'test-a' });
    expect(canResumeFrom(snapshot, state, 'i-1')).toBe(true);
  });

  it('refuses a null snapshot (no file -> cold start)', () => {
    expect(canResumeFrom(null, state, 'i-1')).toBe(false);
  });

  it('refuses a snapshot in a non-resumable phase even if everything else matches', () => {
    const snapshot = validSnapshot({ phase: 'installing', sessionId: 'sid-1', worldId: 'test-a' });
    expect(canResumeFrom(snapshot, state, 'i-1')).toBe(false);
  });

  it('refuses a stale snapshot from a session the state item has moved on from', () => {
    const snapshot = validSnapshot({ sessionId: 'sid-OLD', worldId: 'test-a' });
    expect(canResumeFrom(snapshot, state, 'i-1')).toBe(false);
  });

  it('refuses when the state item belongs to a different instance (this file predates a reboot)', () => {
    const snapshot = validSnapshot({ sessionId: 'sid-1', worldId: 'test-a' });
    expect(canResumeFrom(snapshot, state, 'i-DIFFERENT')).toBe(false);
  });

  it('refuses a worldId mismatch (an in-place switch committed just before the crash)', () => {
    const snapshot = validSnapshot({ sessionId: 'sid-1', worldId: 'test-OLD' });
    expect(canResumeFrom(snapshot, state, 'i-1')).toBe(false);
  });
});

describe('buildSessionSnapshot', () => {
  it('serializes Date fields to ISO strings and passes numbers/strings through', () => {
    const snapshot = buildSessionSnapshot({
      phase: 'running',
      worldId: 'test-a',
      sessionId: '20260919T201355Z-a1b2c3',
      startedAt: new Date('2026-09-19T20:13:04.000Z'),
      joinableAt: new Date('2026-09-19T20:15:49.000Z'),
      lastNonZeroAt: new Date('2026-09-19T20:20:00.000Z'),
      zeroStreak: 1,
      peakPlayers: 2,
      preStartVersionId: 'v1',
      dstBuildId: 'b1',
    });
    expect(snapshot).toEqual(validSnapshot({ zeroStreak: 1, peakPlayers: 2, dstBuildId: 'b1' }));
    expect(isValidSessionSnapshot(snapshot)).toBe(true);
  });

  it('serializes a null joinableAt as null, not "null" or an invalid date', () => {
    const snapshot = buildSessionSnapshot({
      phase: 'starting',
      worldId: 'test-a',
      sessionId: 'sid-1',
      startedAt: new Date('2026-09-19T20:13:04.000Z'),
      joinableAt: null,
      lastNonZeroAt: new Date('2026-09-19T20:13:04.000Z'),
      zeroStreak: 0,
      peakPlayers: 0,
      preStartVersionId: null,
      dstBuildId: '',
    });
    expect(snapshot.joinableAt).toBeNull();
  });
});

describe('sessionFilePath', () => {
  it('is <dstRoot>/run/session.json', () => {
    expect(sessionFilePath('/opt/dst')).toBe('/opt/dst/run/session.json');
  });
});

describe('readSessionSnapshot / writeSessionSnapshot (real filesystem, tmp dir)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dst-session-'));
    await writeFile(join(dir, '.keep'), '', 'utf8').catch(() => undefined);
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(dir, 'run'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist (cold start)', async () => {
    expect(await readSessionSnapshot(dir)).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', async () => {
    await writeFile(sessionFilePath(dir), '{ not json', 'utf8');
    expect(await readSessionSnapshot(dir)).toBeNull();
  });

  it('returns null for well-formed JSON that is not a valid snapshot', async () => {
    await writeFile(sessionFilePath(dir), JSON.stringify({ hello: 'world' }), 'utf8');
    expect(await readSessionSnapshot(dir)).toBeNull();
  });

  it('round-trips a snapshot written by writeSessionSnapshot', async () => {
    const snapshot = validSnapshot();
    await writeSessionSnapshot(dir, snapshot);
    expect(await readSessionSnapshot(dir)).toEqual(snapshot);
  });

  it('never leaves a half-written file behind (atomic rename, no stray .tmp)', async () => {
    await writeSessionSnapshot(dir, validSnapshot());
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(join(dir, 'run'));
    expect(entries).toEqual(['session.json']);
  });

  it('a later write fully replaces the earlier one', async () => {
    await writeSessionSnapshot(dir, validSnapshot({ zeroStreak: 0 }));
    await writeSessionSnapshot(dir, validSnapshot({ zeroStreak: 3 }));
    const readBack = await readSessionSnapshot(dir);
    expect(readBack?.zeroStreak).toBe(3);
  });

  it('never contains the literal strings "cluster_password" or "klei" (secret hygiene)', async () => {
    await writeSessionSnapshot(dir, validSnapshot());
    const raw = await readFile(sessionFilePath(dir), 'utf8');
    expect(raw.toLowerCase()).not.toMatch(/cluster_password|klei/);
  });
});
