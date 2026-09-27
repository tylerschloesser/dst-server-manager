// docs/web.md §3 Recap: pure presentation helpers for a `RecapView`. No React, unit-tested.
import type {
  RecapContainerGroup,
  RecapDeath,
  RecapItem,
  RecapItemCondition,
  RecapNamedCount,
  RecapPlayerView,
  RecapPosition,
  RecapView,
} from '@dst/shared';

const MINUS = '−';

/** nickname (allowlist) ?? persona (in game) ?? "Player N". Never a KU id or SteamID64 — the API
 *  does not send them. */
export function playerLabel(p: Pick<RecapPlayerView, 'nickname' | 'persona'>, index: number) {
  return p.nickname ?? p.persona ?? `Player ${index + 1}`;
}

/** "Days 53 → 60 · spring → summer"; one day / one season collapse ("Day 60 · summer"). */
export function recapHeadline(recap: Pick<RecapView, 'time'>): string {
  const { start, end } = recap.time;
  if (start === null && end === null) return 'Session recap';
  const a = start ?? end;
  const b = end ?? start;
  if (a === null || b === null) return 'Session recap';
  const days = a.day === b.day ? `Day ${b.day}` : `Days ${a.day} → ${b.day}`;
  const seasons = a.season === b.season || a.season === '' ? b.season : `${a.season} → ${b.season}`;
  return seasons === '' ? days : `${days} · ${seasons}`;
}

const STOP_REASONS: Record<string, string> = {
  idle: 'ended once everyone left',
  user: 'stopped from this page',
  switch: 'ended to switch worlds',
  crash: 'the server crashed',
  'reaper-max-age': 'hit the 12-hour limit',
  'reaper-stale': 'the server stopped responding',
  'launch-failed': 'the server failed to start',
};

export function stopReasonText(reason: string | null): string | null {
  if (reason === null) return null;
  return STOP_REASONS[reason] ?? null;
}

/** "42 min" / "1 h 4 min" of real time. */
export function realMinutesText(minutes: number | null): string | null {
  if (minutes === null || minutes < 0) return null;
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** The small print under the headline: season starts, real time, why it ended. */
export function recapDetails(recap: Pick<RecapView, 'time' | 'session'>): string[] {
  const out: string[] = [];
  for (const c of recap.time.seasonChanges) out.push(`${c.season} began day ${c.day}`);
  const real = realMinutesText(recap.session.realMinutes);
  if (real !== null) out.push(`${real} real time`);
  const why = stopReasonText(recap.session.stopReason);
  if (why !== null) out.push(why);
  return out;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/** "20 uses · spoils in 4.5 d". Fuel and armor are raw engine units, shown as such. */
export function conditionText(c: RecapItemCondition | undefined): string | null {
  if (c === undefined) return null;
  const parts: string[] = [];
  if (c.usesLeft !== undefined)
    parts.push(c.usesLeft === 1 ? '1 use' : `${trimNumber(c.usesLeft)} uses`);
  if (c.perishDaysLeft !== undefined) {
    parts.push(c.perishDaysLeft <= 0 ? 'spoiled' : `spoils in ${trimNumber(c.perishDaysLeft)} d`);
  }
  if (c.armor !== undefined) parts.push(`armor ${trimNumber(c.armor)}`);
  if (c.fuel !== undefined) parts.push(`fuel ${trimNumber(c.fuel)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "Log ×17 (…)". */
export function itemText(item: RecapItem): string {
  const count = item.count > 1 ? ` ×${item.count}` : '';
  const cond = conditionText(item.condition);
  return `${item.name}${count}${cond !== null ? ` (${cond})` : ''}`;
}

export function deltaText(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : '0';
}

/** "Chest", "Chest ×2" for built/destroyed lists (the sign is implied by the list). */
export function countedName(c: RecapNamedCount): string {
  const n = Math.abs(c.delta);
  return n > 1 ? `${c.name} ×${n}` : c.name;
}

/** Biggest changes first; the rest folded into "and N more". */
export function topChanges(
  list: RecapNamedCount[],
  max = 8,
): { shown: RecapNamedCount[]; more: number } {
  const sorted = [...list].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { shown: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

/** "57 Rocky · 58 Grass (base) · 59 Mushroom (caves)". */
export function dailyBiomesText(positions: RecapPosition[]): string | null {
  if (positions.length === 0) return null;
  return positions
    .map((p) => {
      const where = p.biome ?? 'somewhere';
      const tags = [p.atBase ? 'base' : null, p.shard === 'caves' ? 'caves' : null].filter(
        (t): t is string => t !== null,
      );
      return `${p.day} ${where}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
    })
    .join(' · ');
}

/** "857 new tiles · 42 in the caves"; null when neither shard had a map. */
export function newTilesText(p: Pick<RecapPlayerView, 'newTiles'>): string | null {
  const { master, caves } = p.newTiles;
  const parts: string[] = [];
  if (master !== null) parts.push(`${master} new tile${master === 1 ? '' : 's'}`);
  if (caves !== null && caves > 0) parts.push(`${caves} in the caves`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "bob: Overheating, revived by Ally after 4 min". */
export function deathText(d: RecapDeath, players: RecapPlayerView[]): string {
  const idx = d.player === null ? -1 : players.findIndex((p) => p.ref === d.player);
  const who = idx >= 0 ? playerLabel(players[idx]!, idx) : d.persona;
  let text = `${who}: ${d.cause}`;
  if (d.revivedBy !== null) {
    const rIdx = players.findIndex((p) => p.persona === d.revivedBy);
    const reviver = rIdx >= 0 ? playerLabel(players[rIdx]!, rIdx) : d.revivedBy;
    text += `, revived by ${reviver}`;
    if (d.revivedAfterMinutes !== null) text += ` after ${Math.round(d.revivedAfterMinutes)} min`;
  } else {
    text += ', not revived';
  }
  return text;
}

/** "Chest ×5 (surface): Cut Grass 60, Twigs 40, … and 2 more" — `items[].delta` is a total here. */
export function containerGroupText(g: RecapContainerGroup, maxItems = 6): string {
  const where = g.shard === 'caves' ? 'caves' : 'surface';
  const head = `${g.name}${g.containers > 1 ? ` ×${g.containers}` : ''} (${where})`;
  if (g.items.length === 0) return `${head}: empty`;
  const sorted = [...g.items].sort((a, b) => b.delta - a.delta);
  const shown = sorted.slice(0, maxItems).map((i) => `${i.name} ${i.delta}`);
  const more = sorted.length - shown.length;
  return `${head}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/** "Sun, Sep 27" in the viewer's locale, from when the session stopped (or started). */
export function sessionDateText(recap: Pick<RecapView, 'session'>, locale?: string): string | null {
  const iso = recap.session.stoppedAt ?? recap.session.startedAt;
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}
