// @dst/supervisor adapters: the real wall clock (docs/game-server.md §8). `core/` never reads
// `Date.now()` directly; this is the one implementation of `ClockPort` that does.
import type { ClockPort } from '../core';

export type Clock = ClockPort;

export function createClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
  };
}
