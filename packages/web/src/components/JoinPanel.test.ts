import { describe, expect, it } from 'vitest';
import type { CountdownState } from '../hooks/useCountdown';
import { idleCountdownText } from './JoinPanel';

function countdown(totalSeconds: number, expired = false): CountdownState {
  return { totalSeconds, label: `${totalSeconds}s`, expired };
}

describe('idleCountdownText', () => {
  it('shows the "everyone has left" message while players are online', () => {
    expect(idleCountdownText(2, '2026-09-19T00:00:00Z', countdown(60))).toBe(
      'Auto-stops once everyone has left.',
    );
  });

  it('renders nothing without an idle deadline', () => {
    expect(idleCountdownText(0, null, countdown(0))).toBeNull();
  });

  it('shows the formatted countdown while it is running', () => {
    expect(idleCountdownText(0, '2026-09-19T00:00:00Z', countdown(60))).toBe(
      'Stops in 60s if nobody is playing',
    );
  });

  it('shows "Stopping soon…" once the countdown has expired', () => {
    expect(idleCountdownText(0, '2026-09-19T00:00:00Z', countdown(0, true))).toBe('Stopping soon…');
  });

  it('treats a null player count the same as zero', () => {
    expect(idleCountdownText(null, '2026-09-19T00:00:00Z', countdown(30))).toBe(
      'Stops in 30s if nobody is playing',
    );
  });
});
