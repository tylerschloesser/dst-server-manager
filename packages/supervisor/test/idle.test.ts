import { describe, expect, it } from 'vitest';

import {
  applyPoll,
  buildPollOutcome,
  computeIdleDeadline,
  decideIdleStop,
  initialIdleState,
  UNKNOWN_STREAK_CRASH_THRESHOLD,
} from '../src/core/idle';
import type { IdleState, PollOutcome } from '../src/core/idle';

const T0 = new Date('2026-01-01T00:00:00.000Z');
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

const ZERO: PollOutcome = { kind: 'count', players: 0, disagreement: false };
const NONZERO: PollOutcome = { kind: 'count', players: 2, disagreement: false };
const UNKNOWN: PollOutcome = { kind: 'unknown' };
const DISAGREE: PollOutcome = { kind: 'count', players: 0, disagreement: true };

describe('applyPoll', () => {
  it('one zero reading does not start the idle clock', () => {
    const s0 = initialIdleState(T0);
    const s1 = applyPoll(s0, ZERO, at(30));
    expect(s1.zeroStreak).toBe(1);
    expect(s1.lastNonZeroAt).toEqual(at(30)); // zeroStreak < 3: clock still advances
  });

  it('three consecutive zero polls are required', () => {
    let s: IdleState = initialIdleState(T0);
    s = applyPoll(s, ZERO, at(30));
    s = applyPoll(s, ZERO, at(60));
    expect(s.zeroStreak).toBe(2);
    expect(s.lastNonZeroAt).toEqual(at(60)); // still under 3: clock holds "now"
    s = applyPoll(s, ZERO, at(90));
    expect(s.zeroStreak).toBe(3);
    expect(s.lastNonZeroAt).toEqual(at(60)); // the 3rd zero freezes the clock at the prior time
  });

  it('a non-zero reading between zeros resets the streak', () => {
    let s: IdleState = initialIdleState(T0);
    s = applyPoll(s, ZERO, at(30));
    s = applyPoll(s, ZERO, at(60));
    s = applyPoll(s, NONZERO, at(90));
    expect(s.zeroStreak).toBe(0);
    expect(s.unknownStreak).toBe(0);
    expect(s.lastNonZeroAt).toEqual(at(90));
  });

  it('unknown reading is never treated as zero', () => {
    let s: IdleState = initialIdleState(T0);
    s = applyPoll(s, ZERO, at(30));
    s = applyPoll(s, ZERO, at(60));
    const before = s;
    s = applyPoll(s, UNKNOWN, at(90));
    expect(s.unknownStreak).toBe(1);
    // the zero streak and the clock both hold — an UNKNOWN neither zeroes nor un-zeroes it.
    expect(s.zeroStreak).toBe(before.zeroStreak);
    expect(s.lastNonZeroAt).toEqual(before.lastNonZeroAt);
  });

  it('10 consecutive unknowns reach the crash threshold', () => {
    let s: IdleState = initialIdleState(T0);
    for (let i = 0; i < UNKNOWN_STREAK_CRASH_THRESHOLD; i++) {
      s = applyPoll(s, UNKNOWN, at(30 * (i + 1)));
    }
    expect(s.unknownStreak).toBe(UNKNOWN_STREAK_CRASH_THRESHOLD);
  });

  it('players===0 with a pause disagreement holds the clock without counting as a zero', () => {
    const s0 = initialIdleState(T0);
    const s1 = applyPoll(s0, DISAGREE, at(30));
    expect(s1.zeroStreak).toBe(0);
    expect(s1.unknownStreak).toBe(0);
    expect(s1.lastNonZeroAt).toEqual(T0);
  });
});

describe('computeIdleDeadline', () => {
  it('is max(joinableAt, lastNonZeroAt) + idleMinutes', () => {
    const joinableAt = at(0);
    const lastNonZeroAt = at(120);
    expect(computeIdleDeadline(joinableAt, lastNonZeroAt, 30)).toEqual(
      new Date(lastNonZeroAt.getTime() + 30 * 60_000),
    );
  });

  it('falls back to joinableAt when it is later than lastNonZeroAt', () => {
    const joinableAt = at(300);
    const lastNonZeroAt = at(0);
    expect(computeIdleDeadline(joinableAt, lastNonZeroAt, 30)).toEqual(
      new Date(joinableAt.getTime() + 30 * 60_000),
    );
  });

  it('idleMinutes=3 fires at 3 minutes', () => {
    const joinableAt = T0;
    const deadline = computeIdleDeadline(joinableAt, joinableAt, 3);
    expect(decideIdleStop(initialIdleState(T0), deadline, at(179)).stop).toBe(false);
    expect(decideIdleStop(initialIdleState(T0), deadline, at(180))).toEqual({
      stop: true,
      reason: 'idle',
    });
  });
});

describe('decideIdleStop', () => {
  it('does not stop before the deadline with a healthy unknown streak', () => {
    const deadline = at(1800);
    expect(decideIdleStop(initialIdleState(T0), deadline, at(100))).toEqual({ stop: false });
  });

  it('stops with reason idle at/after the deadline', () => {
    const deadline = at(1800);
    expect(decideIdleStop(initialIdleState(T0), deadline, at(1800))).toEqual({
      stop: true,
      reason: 'idle',
    });
  });

  it('stops with reason crash once unknownStreak reaches the threshold, even before the deadline', () => {
    const deadline = at(999_999);
    const state: IdleState = {
      zeroStreak: 0,
      unknownStreak: UNKNOWN_STREAK_CRASH_THRESHOLD,
      lastNonZeroAt: T0,
    };
    expect(decideIdleStop(state, deadline, at(100))).toEqual({ stop: true, reason: 'crash' });
  });

  it('the idle deadline survives a rehydrate from session.json (plain-data round trip)', () => {
    let s: IdleState = initialIdleState(T0);
    s = applyPoll(s, ZERO, at(30));
    s = applyPoll(s, ZERO, at(60));
    s = applyPoll(s, ZERO, at(90));
    const rehydrated: IdleState = JSON.parse(
      JSON.stringify({ ...s, lastNonZeroAt: s.lastNonZeroAt.toISOString() }),
    );
    const restored: IdleState = {
      ...rehydrated,
      lastNonZeroAt: new Date(rehydrated.lastNonZeroAt),
    };
    expect(restored).toEqual(s);
  });
});

describe('buildPollOutcome', () => {
  it('is unknown when the reading is unknown', () => {
    expect(buildPollOutcome('unknown', null, true)).toEqual({ kind: 'unknown' });
  });

  it('flags a disagreement only when the cross-check is enabled, players is 0 and simPaused is false', () => {
    expect(buildPollOutcome(0, false, true)).toEqual({
      kind: 'count',
      players: 0,
      disagreement: true,
    });
    expect(buildPollOutcome(0, true, true)).toEqual({
      kind: 'count',
      players: 0,
      disagreement: false,
    });
    expect(buildPollOutcome(0, false, false)).toEqual({
      kind: 'count',
      players: 0,
      disagreement: false,
    });
  });

  it('never disagrees when players is non-zero', () => {
    expect(buildPollOutcome(3, false, true)).toEqual({
      kind: 'count',
      players: 3,
      disagreement: false,
    });
  });
});
