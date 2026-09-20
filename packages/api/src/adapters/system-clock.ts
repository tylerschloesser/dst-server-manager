// Real clock (docs/control-plane.md §5.1).
import type { Clock } from '../ports';

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
