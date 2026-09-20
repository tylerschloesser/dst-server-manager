// @dst/supervisor core: idle-detection maths (docs/decisions.md §5, docs/game-server.md §7, §12).
// Pure: every timestamp is a `Date` argument, never read from the wall clock directly. `IdleState` is exactly the
// subset of `/opt/dst/run/session.json` needed to survive a supervisor restart without silently
// resetting the idle clock (docs/game-server.md §8).
import { ZERO_READINGS_REQUIRED } from '@dst/shared';

/** ~5 minutes at the 30 s poll interval (docs/game-server.md §7). Not a `@dst/shared` constant:
 *  it is derived from `PLAYER_POLL_MS` and is specific to the crash-detection rule. */
export const UNKNOWN_STREAK_CRASH_THRESHOLD = 10;

export interface IdleState {
  readonly zeroStreak: number;
  readonly unknownStreak: number;
  readonly lastNonZeroAt: Date;
}

export function initialIdleState(joinableAt: Date): IdleState {
  return { zeroStreak: 0, unknownStreak: 0, lastNonZeroAt: joinableAt };
}

export type PollOutcome =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'count'; readonly players: number; readonly disagreement: boolean };

/**
 * One 30 s poll's effect on the idle clock (docs/game-server.md §7 "Idle maths"):
 *
 * ```
 * UNKNOWN                     -> unknownStreak++                              (clock holds)
 * players > 0                 -> zeroStreak = 0; unknownStreak = 0; lastNonZeroAt = now
 * players == 0, disagreement  -> unknownStreak = 0                            (clock holds)
 * players == 0                -> zeroStreak++; unknownStreak = 0
 *                                if (zeroStreak < 3) lastNonZeroAt = now      (3-zero rule)
 * ```
 */
export function applyPoll(state: IdleState, outcome: PollOutcome, now: Date): IdleState {
  if (outcome.kind === 'unknown') {
    return { ...state, unknownStreak: state.unknownStreak + 1 };
  }

  if (outcome.players > 0) {
    return { zeroStreak: 0, unknownStreak: 0, lastNonZeroAt: now };
  }

  // players === 0
  if (outcome.disagreement) {
    return { ...state, unknownStreak: 0 };
  }

  const zeroStreak = state.zeroStreak + 1;
  const lastNonZeroAt = zeroStreak < ZERO_READINGS_REQUIRED ? now : state.lastNonZeroAt;
  return { zeroStreak, unknownStreak: 0, lastNonZeroAt };
}

/** `idleDeadline = max(joinableAt, lastNonZeroAt) + idleMinutes * 60_000`. */
export function computeIdleDeadline(
  joinableAt: Date,
  lastNonZeroAt: Date,
  idleMinutes: number,
): Date {
  const base = Math.max(joinableAt.getTime(), lastNonZeroAt.getTime());
  return new Date(base + idleMinutes * 60_000);
}

export type IdleDecision =
  { readonly stop: false } | { readonly stop: true; readonly reason: 'idle' | 'crash' };

/** `now >= idleDeadline -> stop 'idle'`; `unknownStreak >= 10 -> stop 'crash'` (checked first: a
 *  dead shard should never be mistaken for a merely-idle one). */
export function decideIdleStop(state: IdleState, idleDeadline: Date, now: Date): IdleDecision {
  if (state.unknownStreak >= UNKNOWN_STREAK_CRASH_THRESHOLD) {
    return { stop: true, reason: 'crash' };
  }
  if (now.getTime() >= idleDeadline.getTime()) {
    return { stop: true, reason: 'idle' };
  }
  return { stop: false };
}

/**
 * `players === 0 && !simPaused` is a disagreement (docs/game-server.md §7): a `PollOutcome`
 * builder that folds the pause cross-check in, given the shard-count formula's result.
 * `crossCheckEnabled` is `false` once the cross-check has been disabled for the session (no pause
 * edge 3 polls after joinable, or `pause_when_empty` is not `true`) — count-only from then on.
 */
export function buildPollOutcome(
  reading: number | 'unknown',
  simPaused: boolean | null,
  crossCheckEnabled: boolean,
): PollOutcome {
  if (reading === 'unknown') return { kind: 'unknown' };
  const disagreement = crossCheckEnabled && reading === 0 && simPaused === false;
  return { kind: 'count', players: reading, disagreement };
}
