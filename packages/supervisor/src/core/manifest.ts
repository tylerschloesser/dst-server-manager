// @dst/supervisor core: the session manifest (docs/storage.md §8, docs/game-server.md §10). The
// schema is owned by docs/storage.md §8; this is the TypeScript shape the supervisor writes.
import type { StopReason } from '@dst/shared';

export interface SessionManifest {
  readonly sessionId: string;
  readonly worldId: string;
  /** A NICKNAME, never a SteamID64 (the instance never reads `/dst/users`, decisions §16.6). */
  readonly startedBy: string;
  readonly startedAt: string;
  readonly joinableAt: string | null;
  readonly stoppedAt: string;
  readonly stopReason: StopReason;
  readonly peakPlayers: number;
  readonly instanceType: string;
  readonly dstBuildId: string;
  readonly preStartVersionId: string | null;
  readonly postStopVersionId: string | null;
}

/** `startedBy` is `state.startedByNickname` copied verbatim; `"unknown"` when it is null. */
export function resolveStartedBy(startedByNickname: string | null): string {
  return startedByNickname ?? 'unknown';
}

/** `peakPlayers` is the max over every non-UNKNOWN reading this session; UNKNOWN readings never
 *  move it (docs/game-server.md §12). */
export function trackPeakPlayers(peakSoFar: number, reading: number | 'unknown'): number {
  if (reading === 'unknown') return peakSoFar;
  return Math.max(peakSoFar, reading);
}

export interface BuildSessionManifestInput {
  readonly sessionId: string;
  readonly worldId: string;
  readonly startedByNickname: string | null;
  readonly startedAt: string;
  readonly joinableAt: string | null;
  readonly stoppedAt: string;
  readonly stopReason: StopReason;
  readonly peakPlayers: number;
  readonly instanceType: string;
  readonly dstBuildId: string;
  /** `null` when the world was generated (nothing was restored). */
  readonly preStartVersionId: string | null;
  /** `null` when no save was pushed (decisions §16.15). */
  readonly postStopVersionId: string | null;
}

export function buildSessionManifest(input: BuildSessionManifestInput): SessionManifest {
  return {
    sessionId: input.sessionId,
    worldId: input.worldId,
    startedBy: resolveStartedBy(input.startedByNickname),
    startedAt: input.startedAt,
    joinableAt: input.joinableAt,
    stoppedAt: input.stoppedAt,
    stopReason: input.stopReason,
    peakPlayers: input.peakPlayers,
    instanceType: input.instanceType,
    dstBuildId: input.dstBuildId,
    preStartVersionId: input.preStartVersionId,
    postStopVersionId: input.postStopVersionId,
  };
}
