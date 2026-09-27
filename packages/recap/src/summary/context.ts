// Builds the LLM's input from digests (docs/decisions.md §18). Deterministic text, not raw JSON:
// a fact sheet is ~3x fewer tokens than the recap JSON and states each fact once, in words the
// model can quote. Never raw logs (map-inventory-recap.md §3.3: ~90% of server_log is noise).
//
// Every knob the prompt lab varies is an option here, so a variant is (system prompt, options).
import type { Recap, RecapCarrying, RecapItem, RecapPlayer } from '@dst/shared';

export interface ContextOptions {
  /** How much of each player's inventory to include. */
  inventory: 'full' | 'brief' | 'none';
  /** Previous sessions: their stored summaries, compact fact sheets, or nothing. */
  previous: 'summaries' | 'digests' | 'none';
  previousCount: number;
  /** Include the storage contents at the stop ("where our stuff is"). */
  containers: boolean;
  /** Storage *changes* to list (largest first). */
  storageChanges: number;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  // 'full' costs ~200 input tokens more than 'brief' but 'brief' (tools/armor/food only) led the
  // model to claim clothing was missing (prompt lab, v3).
  inventory: 'full',
  previous: 'summaries',
  previousCount: 2,
  containers: true,
  storageChanges: 8,
};

export interface PreviousSession {
  recap: Recap;
  /** The stored `summary.md`, when that session got one. */
  summary: string | null;
}

export interface SummaryContextInput {
  recap: Recap;
  /** The world's "next time" note (docs/decisions.md §18), if any. */
  note: string | null;
  /** Oldest first. */
  previous: PreviousSession[];
}

const SEASON_LENGTH_HINT: Record<string, string> = {
  autumn: 'winter',
  winter: 'spring',
  spring: 'summer',
  summer: 'autumn',
};

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function playerLabel(p: RecapPlayer): string {
  const who = p.persona ?? `Player ${p.ref.slice(1)}`;
  return p.characterName !== null ? `${who} (${p.characterName})` : who;
}

function itemText(i: RecapItem): string {
  const bits: string[] = [];
  const c = i.condition;
  if (c?.usesLeft !== undefined) bits.push(`${c.usesLeft} uses`);
  if (c?.armor !== undefined) bits.push(`armor ${c.armor}`);
  if (c?.fuel !== undefined) bits.push(`fuel ${c.fuel}`);
  if (c?.perishDaysLeft !== undefined) bits.push(`spoils in ${c.perishDaysLeft} d`);
  const count = i.count > 1 ? ` x${i.count}` : '';
  return `${i.name}${count}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}`;
}

/** Merges identical item names so "Log x20, Log x5" reads "Log x25". */
function mergeItems(items: RecapItem[]): RecapItem[] {
  const out = new Map<string, RecapItem>();
  for (const i of items) {
    const key = i.condition === undefined ? i.name : `${i.name}#${out.size}`;
    const prev = out.get(key);
    if (prev !== undefined) prev.count += i.count;
    else out.set(key, { ...i });
  }
  return [...out.values()];
}

function carryingText(c: RecapCarrying, level: 'full' | 'brief'): string[] {
  const lines: string[] = [];
  if (c.equipped.length > 0) {
    lines.push(`equipped: ${c.equipped.map((e) => `${e.slot} ${itemText(e.item)}`).join('; ')}`);
  }
  const inv = mergeItems(c.inventory);
  if (level === 'full') {
    lines.push(`inventory: ${inv.map(itemText).join('; ') || 'empty'}`);
    if (c.backpack !== null) {
      lines.push(
        `${c.backpack.name}: ${mergeItems(c.backpack.items).map(itemText).join('; ') || 'empty'}`,
      );
    }
  } else {
    const food = inv.filter((i) => i.condition?.perishDaysLeft !== undefined);
    const tools = inv.filter(
      (i) => i.condition?.usesLeft !== undefined || i.condition?.armor !== undefined,
    );
    lines.push(`inventory: ${inv.length} kinds of item`);
    if (tools.length > 0) lines.push(`tools/armor: ${tools.map(itemText).join('; ')}`);
    if (food.length > 0) lines.push(`food: ${food.map(itemText).join('; ')}`);
    if (c.backpack !== null)
      lines.push(`wearing a ${c.backpack.name} with ${c.backpack.items.length} slots used`);
  }
  return lines;
}

/** The save holds current values but not each character's maximum, so raw numbers mislead
 *  ("150 health" is full for one character, low for another). Only clearly low values are
 *  reported; the thresholds are low for every character (max 150-300 in the base game). */
const LOW = { health: 60, hunger: 40, sanity: 50 } as const;
export function lowStats(p: RecapPlayer): string | null {
  if (p.stats === null) return null;
  const parts: string[] = [];
  for (const k of ['health', 'hunger', 'sanity'] as const) {
    const v = p.stats[k];
    if (v !== null && v < LOW[k]) parts.push(`low ${k} (${v})`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function whereText(p: RecapPlayer): string {
  const parts = p.dailyPositions.map(
    (d) =>
      `day ${d.day} ${d.shard === 'caves' ? 'caves' : 'surface'} ${d.biome ?? '?'}${d.atBase ? ' (base)' : ''}`,
  );
  const dawn = parts.length > 0 ? `dawn positions: ${parts.join(', ')}` : 'no dawn positions saved';
  const last =
    p.lastPosition !== null
      ? `at the stop: ${p.lastPosition.shard === 'caves' ? 'in the caves' : 'on the surface'}, ${p.lastPosition.biome ?? 'unknown area'}${p.lastPosition.atBase ? ', at the base' : ''}`
      : 'position at the stop unknown';
  return `${dawn}; ${last}`;
}

/** The fact sheet for ONE session. `detail` = false gives the compact form used for previous
 *  sessions. */
export function factSheet(recap: Recap, opts: ContextOptions, detail = true): string {
  const L: string[] = [];
  const t = recap.time;
  const s = recap.session;
  const date = (s.stoppedAt ?? s.startedAt ?? '').slice(0, 10);
  L.push(
    `Session ${recap.sessionId} (${date}), ${s.realMinutes ?? '?'} min real time, ` +
      `stop reason: ${s.stopReason ?? 'unknown'}, peak players: ${s.peakPlayers ?? '?'}.`,
  );
  if (recap.continuous === false)
    L.push('Before this session the world was restored from an older save.');
  if (t.start !== null && t.end !== null) {
    const seasonStr = (p: NonNullable<typeof t.start>) =>
      `${p.season}${p.dayOfSeason !== null ? ` day ${p.dayOfSeason}` : ''}${p.daysLeftInSeason !== null ? `, ${p.daysLeftInSeason} days left in the season incl. today` : ''}`;
    L.push(
      `Calendar: day ${t.start.day} (${seasonStr(t.start)}) -> day ${t.end.day} (${seasonStr(t.end)}).`,
    );
    for (const c of t.seasonChanges) L.push(`${c.season} began on day ${c.day}.`);
    const next = SEASON_LENGTH_HINT[t.end.season];
    if (next !== undefined && t.end.daysLeftInSeason !== null) {
      L.push(`Next season: ${next}, in ${t.end.daysLeftInSeason} days.`);
    }
  }
  if (recap.status === 'partial') L.push(`Only partly digested: ${recap.notes.join(' ')}`);

  const active = recap.players.filter((p) => p.presentAfter || p.persona !== null);
  if (active.length === 0) {
    L.push('Nobody played this session (no player saves changed).');
    return L.join('\n');
  }
  L.push(`Players: ${active.map(playerLabel).join(', ')}.`);
  const byRef = new Map(recap.players.map((p) => [p.ref, p]));
  const name = (ref: string | null, persona: string): string =>
    byRef.get(ref ?? '')?.persona ?? persona;

  if (recap.deaths.length > 0) {
    for (const d of recap.deaths) {
      const revived =
        d.revivedBy !== null
          ? `, revived by ${d.revivedBy} ${d.revivedAfterMinutes ?? '?'} min later`
          : d.revivedAfterMinutes !== null
            ? `, revived ${d.revivedAfterMinutes} min later`
            : ', not revived during the session';
      L.push(
        `Death: ${name(d.player, d.persona)} killed by ${d.cause}, ${d.minute} min into the session${revived}.`,
      );
    }
  } else {
    L.push('Deaths: none.');
  }
  L.push(
    `Built: ${recap.built.map((b) => `${b.name} x${b.delta}`).join(', ') || 'nothing'}.` +
      (recap.destroyed.length > 0
        ? ` Gone: ${recap.destroyed.map((b) => `${b.name} x${b.delta}`).join(', ')}.`
        : ''),
  );
  for (const p of active) {
    if (p.learned.length > 0)
      L.push(`${p.persona ?? p.ref} learned: ${p.learned.map((r) => r.name).join(', ')}.`);
  }
  if (!detail) {
    for (const p of active) L.push(`${p.persona ?? p.ref}: ${whereText(p)}.`);
    return L.join('\n');
  }

  if (opts.storageChanges > 0 && recap.storage.length > 0) {
    const shown = recap.storage.slice(0, opts.storageChanges);
    L.push(
      `Storage changes (all chests, ice boxes, Chester…): ${shown.map((c) => `${c.name} ${signed(c.delta)}`).join(', ')}` +
        (recap.storage.length > shown.length
          ? `, and ${recap.storage.length - shown.length} smaller changes`
          : '') +
        '.',
    );
  }
  // Empty containers (idle Crock Pots, bare racks) are the normal state between uses; listing
  // them made every model nag "the Crock Pots are still empty" (prompt lab, v2).
  const stocked = recap.containers.filter((g) => g.items.length > 0);
  if (opts.containers && stocked.length > 0) {
    L.push('Storage contents at the stop:');
    for (const g of stocked) {
      const where = g.shard === 'caves' ? 'caves' : 'surface';
      const items = g.items
        .slice(0, 10)
        .map((i) => `${i.name} ${i.delta}`)
        .join(', ');
      L.push(
        `- ${g.name} x${g.containers} (${where}): ${items || 'empty'}${g.items.length > 10 ? ', …' : ''}`,
      );
    }
  }
  for (const p of active) {
    L.push(`${playerLabel(p)}:`);
    const tiles = (['master', 'caves'] as const)
      .filter((k) => p.newTiles[k] !== null)
      .map((k) => `${p.newTiles[k]} new ${k === 'master' ? 'surface' : 'cave'} tiles`);
    L.push(`- explored: ${tiles.join(', ') || 'no map data'}; cave trips: ${p.caveTrips}`);
    L.push(`- ${whereText(p)}`);
    const low = lowStats(p);
    if (low !== null) L.push(`- at the stop: ${low}`);
    if (opts.inventory !== 'none' && p.carrying !== null) {
      for (const line of carryingText(p.carrying, opts.inventory)) L.push(`- ${line}`);
    }
  }
  return L.join('\n');
}

/** The single user message: previous sessions (oldest first), the note, then this session. */
export function buildContext(
  input: SummaryContextInput,
  opts: ContextOptions,
): { text: string; contextSessions: string[] } {
  const parts: string[] = [];
  const used: string[] = [];
  const prev = opts.previous === 'none' ? [] : input.previous.slice(-opts.previousCount);
  if (prev.length > 0) {
    parts.push('<previous_sessions>');
    for (const p of prev) {
      used.push(p.recap.sessionId);
      if (opts.previous === 'summaries' && p.summary !== null) {
        parts.push(
          `<session id="${p.recap.sessionId}" kind="summary written after it">\n${p.summary.trim()}\n</session>`,
        );
      } else {
        parts.push(
          `<session id="${p.recap.sessionId}" kind="facts">\n${factSheet(p.recap, opts, false)}\n</session>`,
        );
      }
    }
    parts.push('</previous_sessions>');
  }
  parts.push(
    input.note !== null && input.note.trim() !== ''
      ? `<players_note>\n${input.note.trim()}\n</players_note>`
      : '<players_note>(none)</players_note>',
  );
  parts.push(`<this_session>\n${factSheet(input.recap, opts, true)}\n</this_session>`);
  return { text: parts.join('\n\n'), contextSessions: used };
}
