import { describe, expect, it } from 'vitest';
import { formatCountdown, playerCountLabel } from './format';

describe('formatCountdown', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatCountdown(1634)).toBe('27:14');
    expect(formatCountdown(95)).toBe('1:35');
    expect(formatCountdown(5)).toBe('0:05');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatCountdown(3661)).toBe('1:01:01');
  });

  it('clamps negative values to zero', () => {
    expect(formatCountdown(-10)).toBe('0:00');
  });
});

describe('playerCountLabel', () => {
  it('reports unavailable for null (UNKNOWN, never coerced to zero)', () => {
    expect(playerCountLabel(null)).toBe('Player count unavailable');
  });

  it('reports zero distinctly', () => {
    expect(playerCountLabel(0)).toBe('No players online yet');
  });

  it('uses the singular for one player', () => {
    expect(playerCountLabel(1)).toBe('1 player online');
  });

  it('uses the plural for more than one player', () => {
    expect(playerCountLabel(3)).toBe('3 players online');
  });
});
