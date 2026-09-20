import { describe, expect, it } from 'vitest';
import { computeCountdown } from './useCountdown';

describe('computeCountdown', () => {
  it('is expired with no deadline', () => {
    expect(computeCountdown(null, 0)).toEqual({ totalSeconds: 0, label: '0:00', expired: true });
    expect(computeCountdown(undefined, 0)).toEqual({
      totalSeconds: 0,
      label: '0:00',
      expired: true,
    });
  });

  it('computes the seconds remaining from now to the deadline', () => {
    const now = Date.parse('2026-09-19T00:00:00.000Z');
    const deadline = new Date(now + 95_000).toISOString();

    const result = computeCountdown(deadline, now);

    expect(result).toEqual({ totalSeconds: 95, label: '1:35', expired: false });
  });

  it('is expired, and clamped to zero, once the deadline has passed', () => {
    const now = Date.parse('2026-09-19T00:00:00.000Z');
    const deadline = new Date(now - 5_000).toISOString();

    const result = computeCountdown(deadline, now);

    expect(result).toEqual({ totalSeconds: 0, label: '0:00', expired: true });
  });
});
