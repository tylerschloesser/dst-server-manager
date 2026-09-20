// docs/web.md §2, §4: formatCountdown, playerCountLabel — pure presentation helpers.

/** `m:ss` under an hour (`27:14`), `h:mm:ss` at or above it. No date library. */
export function formatCountdown(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/** docs/web.md §3 JoinPanel player-count readout. `null` is UNKNOWN, never coerced to zero. */
export function playerCountLabel(count: number | null): string {
  if (count === null) return 'Player count unavailable';
  if (count === 0) return 'No players online yet';
  if (count === 1) return '1 player online';
  return `${count} players online`;
}
