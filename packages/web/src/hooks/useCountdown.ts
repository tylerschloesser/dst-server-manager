// docs/web.md §4: countdown to auto-stop from `idleDeadline`.
import { useEffect, useState } from 'react';
import { formatCountdown } from '../lib/format';

export interface CountdownState {
  totalSeconds: number;
  label: string;
  expired: boolean;
}

export function computeCountdown(
  deadlineIso: string | null | undefined,
  nowMs: number,
): CountdownState {
  if (!deadlineIso) {
    return { totalSeconds: 0, label: formatCountdown(0), expired: true };
  }
  const deadlineMs = Date.parse(deadlineIso);
  const totalSeconds = Math.max(0, Math.round((deadlineMs - nowMs) / 1000));
  return { totalSeconds, label: formatCountdown(totalSeconds), expired: totalSeconds <= 0 };
}

/** Ticks every second (cleared on unmount and whenever the deadline changes); no date library. */
export function useCountdown(deadlineIso: string | null | undefined): CountdownState {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    if (!deadlineIso) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);

  return computeCountdown(deadlineIso, nowMs);
}
