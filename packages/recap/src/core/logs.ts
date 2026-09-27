// The session's uploaded logs (docs/research/save-anatomy.md §6-§7). Times are seconds since that
// shard's process started; `manifest.json` anchors wall-clock time.
//
// Every announcement appears in BOTH shards' chat logs (±1 s), so events are deduplicated across
// shards. The logs hold KU ids and SteamID64s: they feed the private `players.json` only.

export interface ChatEvent {
  kind: 'death' | 'revive';
  seconds: number;
  persona: string;
  /** death: cause; revive: reviver persona (null = revived by an object, e.g. a touch stone) */
  detail: string | null;
}

export interface LogIdentity {
  ku: string;
  persona: string | null;
  steamId64: string | null;
  /** userdir -> character, from `Resuming user: …/<userdir>/…` + the next `User ID <KU> assigned
   *  ownership to entity … - <character>` line */
  userdirs: Map<string, string | null>;
}

export interface ParsedLogs {
  events: ChatEvent[];
  /** Boot-time `setting cycles <n>` (Caves, and Master after sync). day = cycles + 1. */
  bootCycles: number | null;
  bootSeason: string | null;
  identities: Map<string, LogIdentity>; // by KU
  /** KU -> number of trips from the surface into the caves */
  caveTrips: Map<string, number>;
  /** KU -> last shard the logs place them on ('master' | 'caves') */
  lastShard: Map<string, 'master' | 'caves'>;
  /** chat lines we recognised as announcements but could not parse (reported, never guessed) */
  unparsed: string[];
}

const LINE_RE = /^\[(\d+):(\d{2}):(\d{2})\]: (.*)$/;

function seconds(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function lines(text: string): { t: number; body: string }[] {
  const out: { t: number; body: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (m !== null) out.push({ t: seconds(m[1]!, m[2]!, m[3]!), body: m[4]!.replace(/\t+$/, '') });
  }
  return out;
}

const DEATH_RE = /^\[Death Announcement\] (.+?) was killed by (.+?)\.(?: .*)?$/;
const DEATH_OTHER_RE = /^\[Death Announcement\] (.+?) (died|starved|froze|drowned|burned)\b/;
const REVIVE_BY_RE = /^\[Resurrect Announcement\] (.+?) was resurrected by (.+?)\.$/;
const REVIVE_RE = /^\[Resurrect Announcement\] (.+?) was resurrected\.?$/;

export function parseChat(text: string, unparsed: string[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const { t, body } of lines(text)) {
    if (body.startsWith('[Death Announcement]')) {
      const m = DEATH_RE.exec(body) ?? DEATH_OTHER_RE.exec(body);
      if (m === null) {
        unparsed.push(body);
        continue;
      }
      out.push({ kind: 'death', seconds: t, persona: m[1]!, detail: m[2]! });
    } else if (body.startsWith('[Resurrect Announcement]')) {
      const by = REVIVE_BY_RE.exec(body);
      const plain = by === null ? REVIVE_RE.exec(body) : null;
      if (by === null && plain === null) {
        unparsed.push(body);
        continue;
      }
      out.push({
        kind: 'revive',
        seconds: t,
        persona: (by ?? plain)![1]!,
        detail: by !== null ? by[2]! : null,
      });
    }
  }
  return out;
}

/** Master's events, plus any Caves event with no Master twin within `windowS` seconds. */
export function dedupeEvents(master: ChatEvent[], caves: ChatEvent[], windowS = 5): ChatEvent[] {
  const out = [...master];
  for (const c of caves) {
    const twin = master.some(
      (m) =>
        m.kind === c.kind &&
        m.persona === c.persona &&
        m.detail === c.detail &&
        Math.abs(m.seconds - c.seconds) <= windowS,
    );
    if (!twin) out.push(c);
  }
  return out.sort((a, b) => a.seconds - b.seconds);
}

const AUTH_RE = /^Client authenticated: \((KU_[A-Za-z0-9_-]+)\) (.+)$/;
const INIT_RE =
  /^\[ClientObject\] Initialized \(authenticated\) on server: .*userid=(KU_[A-Za-z0-9_-]+) netid=(\d{17}) /;
const RESUME_RE = /^Resuming user: session\/[0-9A-F]{16}\/([A-Z0-9]{8,16})\/\d+$/;
const OWNER_RE = /^User ID\s+(KU_[A-Za-z0-9_-]+)\s+assigned ownership to entity\s+\d+ - (\S+)$/;
const MIGRATE_RE =
  /^\[Shard\] Migration request: \((KU_[A-Za-z0-9_-]+)\) to (Caves|Master)\((\d+)\)$/;
const SETTING_RE = /^setting\s+(cycles|season)\s+(\S+)$/;

function identity(map: Map<string, LogIdentity>, ku: string): LogIdentity {
  let id = map.get(ku);
  if (id === undefined) {
    id = { ku, persona: null, steamId64: null, userdirs: new Map() };
    map.set(ku, id);
  }
  return id;
}

function scanServerLog(
  text: string,
  shard: 'master' | 'caves',
  out: ParsedLogs,
  lastMove: Map<string, { t: number; to: 'master' | 'caves'; shard: 'master' | 'caves' }>,
): void {
  let pendingUserdir: string | null = null;
  for (const { t, body } of lines(text)) {
    let m = AUTH_RE.exec(body);
    if (m !== null) {
      identity(out.identities, m[1]!).persona = m[2]!;
      continue;
    }
    m = INIT_RE.exec(body);
    if (m !== null) {
      identity(out.identities, m[1]!).steamId64 = m[2]!;
      continue;
    }
    m = RESUME_RE.exec(body);
    if (m !== null) {
      pendingUserdir = m[1]!;
      continue;
    }
    m = OWNER_RE.exec(body);
    if (m !== null) {
      if (pendingUserdir !== null)
        identity(out.identities, m[1]!).userdirs.set(pendingUserdir, m[2]!);
      pendingUserdir = null;
      continue;
    }
    m = MIGRATE_RE.exec(body);
    if (m !== null) {
      const ku = m[1]!;
      const to = m[2] === 'Caves' ? 'caves' : 'master';
      identity(out.identities, ku);
      if (to === 'caves' && shard === 'master')
        out.caveTrips.set(ku, (out.caveTrips.get(ku) ?? 0) + 1);
      const prev = lastMove.get(ku);
      if (prev === undefined || t >= prev.t) lastMove.set(ku, { t, to, shard });
      continue;
    }
    m = SETTING_RE.exec(body.replace(/\t/g, ' '));
    if (m !== null) {
      if (m[1] === 'cycles' && out.bootCycles === null && /^\d+$/.test(m[2]!))
        out.bootCycles = Number(m[2]);
      if (m[1] === 'season' && out.bootSeason === null) out.bootSeason = m[2]!;
    }
  }
}

export interface SessionLogs {
  masterChat: string | null;
  cavesChat: string | null;
  masterServer: string | null;
  cavesServer: string | null;
}

export function parseLogs(logs: SessionLogs): ParsedLogs {
  const unparsed: string[] = [];
  const out: ParsedLogs = {
    events: dedupeEvents(
      logs.masterChat !== null ? parseChat(logs.masterChat, unparsed) : [],
      logs.cavesChat !== null ? parseChat(logs.cavesChat, []) : [],
    ),
    bootCycles: null,
    bootSeason: null,
    identities: new Map(),
    caveTrips: new Map(),
    lastShard: new Map(),
    unparsed,
  };
  // Only master's unparsed lines are reported; caves repeats them.
  const lastMove = new Map<
    string,
    { t: number; to: 'master' | 'caves'; shard: 'master' | 'caves' }
  >();
  if (logs.masterServer !== null) scanServerLog(logs.masterServer, 'master', out, lastMove);
  if (logs.cavesServer !== null) scanServerLog(logs.cavesServer, 'caves', out, lastMove);
  // The two shards' clocks differ by a few seconds; the last migration request is still the
  // player's final move in practice (they are minutes apart). Players who never migrated stay
  // unknown here and fall back to the save's own `savelocation`.
  for (const [ku, mv] of lastMove) out.lastShard.set(ku, mv.to);
  return out;
}
