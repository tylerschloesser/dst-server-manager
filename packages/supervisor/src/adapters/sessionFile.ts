// @dst/supervisor: `/opt/dst/run/session.json` persistence for crash recovery
// (docs/game-server.md §8 "Crash handling"). `Restart=on-failure` brings the Node process back
// after a crash while the shard units (dst-master/dst-caves) keep running untouched on their own
// systemd units — this file is how the new process recovers the idle clock instead of silently
// resetting it, which CLAUDE.md's "Cost safety" invariant forbids (a bug must not be able to cost
// a month of EC2). Contains none of the Klei token or the cluster password.
//
// The persisted shape is the exact field list decisions/docs/game-server.md §8 names:
// `phase, worldId, sessionId, startedAt, joinableAt, lastNonZeroAt, zeroStreak, peakPlayers,
// preStartVersionId, dstBuildId`. `unknownStreak` (the third field of `core/idle.ts`'s `IdleState`)
// is deliberately not one of them — on a restart it resets to 0, which only delays the
// crash-detection threshold, never the idle-cost deadline that `zeroStreak`/`lastNonZeroAt` govern.
import { readFile, rename, writeFile } from 'node:fs/promises';

import type { IdleState, Phase } from '../core';

export interface SessionSnapshot {
  readonly phase: Phase;
  readonly worldId: string;
  readonly sessionId: string;
  readonly startedAt: string; // ISO 8601
  readonly joinableAt: string | null; // ISO 8601, or null before the world is joinable
  readonly lastNonZeroAt: string; // ISO 8601
  readonly zeroStreak: number;
  readonly peakPlayers: number;
  readonly preStartVersionId: string | null;
  readonly dstBuildId: string;
}

/** The subset of a snapshot that is actually useful to resume into (docs/game-server.md §8: a
 *  restart re-scans the shard logs from 0 and re-reads the state item regardless, so only
 *  `starting`/`running` — where shards are already up on their own systemd units — are worth
 *  resuming; `installing`/`stopping`/`boot`/`halted` are always safe to cold-restart). */
export interface ResumeInfo {
  readonly phase: 'starting' | 'running';
  readonly startedAt: Date;
  readonly joinableAt: Date | null;
  readonly lastNonZeroAt: Date;
  readonly zeroStreak: number;
  readonly peakPlayers: number;
  readonly preStartVersionId: string | null;
  readonly dstBuildId: string;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Never throws — a malformed file must never crash the boot (that would defeat
 *  `Restart=on-failure`, and past its start limit hand the instance to `dst-panic.service`
 *  instead of ever converging). */
export function isValidSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['phase'] === 'string' &&
    typeof v['worldId'] === 'string' &&
    v['worldId'] !== '' &&
    typeof v['sessionId'] === 'string' &&
    v['sessionId'] !== '' &&
    isIsoDate(v['startedAt']) &&
    (v['joinableAt'] === null || isIsoDate(v['joinableAt'])) &&
    isIsoDate(v['lastNonZeroAt']) &&
    isFiniteNumber(v['zeroStreak']) &&
    v['zeroStreak'] >= 0 &&
    isFiniteNumber(v['peakPlayers']) &&
    v['peakPlayers'] >= 0 &&
    (v['preStartVersionId'] === null || typeof v['preStartVersionId'] === 'string') &&
    typeof v['dstBuildId'] === 'string'
  );
}

/** Only `starting`/`running` are ever worth resuming into; anything else (including a phase
 *  string this version of the supervisor does not recognize) means: cold-restart. */
export function toResumeInfo(snapshot: SessionSnapshot): ResumeInfo | null {
  if (snapshot.phase !== 'starting' && snapshot.phase !== 'running') return null;
  return {
    phase: snapshot.phase,
    startedAt: new Date(snapshot.startedAt),
    joinableAt: snapshot.joinableAt !== null ? new Date(snapshot.joinableAt) : null,
    lastNonZeroAt: new Date(snapshot.lastNonZeroAt),
    zeroStreak: snapshot.zeroStreak,
    peakPlayers: snapshot.peakPlayers,
    preStartVersionId: snapshot.preStartVersionId,
    dstBuildId: snapshot.dstBuildId,
  };
}

/**
 * A persisted snapshot is only safe to resume from when it describes the SAME session the state
 * item still says is ours: same `sessionId`, same `worldId`, and the state item's `instanceId` is
 * this instance (docs/game-server.md §8: "re-reads the state item ... and continues"). Anything
 * else — a stale file left over from a previous session on this same disk, a state item that has
 * already moved on — must never resume; the ordinary boot-orphan/claim path decides what happens
 * instead.
 */
export function canResumeFrom(
  snapshot: SessionSnapshot | null,
  state: {
    readonly sessionId: string | null;
    readonly instanceId: string | null;
    readonly worldId: string | null;
  },
  ownInstanceId: string,
): boolean {
  if (snapshot === null) return false;
  if (snapshot.phase !== 'starting' && snapshot.phase !== 'running') return false;
  return (
    state.sessionId === snapshot.sessionId &&
    state.instanceId === ownInstanceId &&
    state.worldId === snapshot.worldId
  );
}

export interface BuildSessionSnapshotInput {
  readonly phase: Phase;
  readonly worldId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly joinableAt: Date | null;
  readonly lastNonZeroAt: Date;
  readonly zeroStreak: number;
  readonly peakPlayers: number;
  readonly preStartVersionId: string | null;
  readonly dstBuildId: string;
}

export function buildSessionSnapshot(input: BuildSessionSnapshotInput): SessionSnapshot {
  return {
    phase: input.phase,
    worldId: input.worldId,
    sessionId: input.sessionId,
    startedAt: input.startedAt.toISOString(),
    joinableAt: input.joinableAt !== null ? input.joinableAt.toISOString() : null,
    lastNonZeroAt: input.lastNonZeroAt.toISOString(),
    zeroStreak: input.zeroStreak,
    peakPlayers: input.peakPlayers,
    preStartVersionId: input.preStartVersionId,
    dstBuildId: input.dstBuildId,
  };
}

/** The idle-clock subset of a `ResumeInfo`, as a genuine `core/idle.ts` `IdleState` — reused, not
 *  re-implemented. `unknownStreak` always restarts at 0 (see the module doc comment above). */
export function idleStateFromResumeInfo(resume: ResumeInfo): IdleState {
  return { zeroStreak: resume.zeroStreak, unknownStreak: 0, lastNonZeroAt: resume.lastNonZeroAt };
}

export function sessionFilePath(dstRoot: string): string {
  return `${dstRoot}/run/session.json`;
}

/** Missing, unreadable or malformed -> `null` (a cold start). Never throws. */
export async function readSessionSnapshot(dstRoot: string): Promise<SessionSnapshot | null> {
  let text: string;
  try {
    text = await readFile(sessionFilePath(dstRoot), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isValidSessionSnapshot(parsed) ? parsed : null;
}

/** Written atomically (temp file + rename in the same directory) so a crash mid-write can never
 *  leave a half-written, unparseable file for the next boot to trip over. Failures are swallowed
 *  by the caller (`persistSession` in `src/index.ts`) — a full disk must not crash the loop. */
export async function writeSessionSnapshot(
  dstRoot: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const path = sessionFilePath(dstRoot);
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(snapshot), 'utf8');
  await rename(tmpPath, path);
}
