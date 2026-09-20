// In-memory Clock fake (docs/control-plane.md §5.1), shared by `local.ts` and tests.
import type { Clock } from '../ports';

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
