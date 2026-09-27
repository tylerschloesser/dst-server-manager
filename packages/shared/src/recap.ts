// Session recap: the digest schema (`sessions/<w>/<s>/digest/recap.json`) and the browser-facing
// API shapes (docs/decisions.md §18, docs/storage.md §8). Types only — `@dst/recap` computes the
// digest, `@dst/api` serves it, `@dst/web` renders it.
//
// Privacy rule (docs/decisions.md §18): nothing in `Recap` identifies a Steam or Klei account.
// Players are keyed by an opaque per-recap `ref` ("p1", "p2", …). The ref → KU → SteamID64 link
// lives only in the sibling `players.json` (`RecapPlayersFile`), which the API reads to attach an
// allowlist nickname and never forwards. A KU id or SteamID64 must never reach a page.

export const RECAP_SCHEMA_VERSION = 1;

export type RecapShard = 'master' | 'caves';

/** One point on the in-game calendar. `day` is what the game shows (`cycles + 1`). */
export interface RecapCalendarPoint {
  day: number;
  season: string; // 'autumn' | 'winter' | 'spring' | 'summer' (lowercase, as the save writes it)
  /** 1-based day within the season, as the in-game clock shows it. */
  dayOfSeason: number | null;
  /** Days left in the season *after* this one, from the save's `remainingdaysinseason`. */
  daysLeftInSeason: number | null;
}

/** A prefab with its English display name (from the game's `STRINGS.NAMES`) and a count. */
export interface RecapNamedCount {
  prefab: string;
  name: string;
  delta: number;
}

export interface RecapNamed {
  prefab: string;
  name: string;
}

/** Wear/freshness of one item, raw from the save. `perishDaysLeft` is derived (480 s per day). */
export interface RecapItemCondition {
  usesLeft?: number; // finiteuses.uses
  fuel?: number; // fueled.fuel (engine units, not a percentage)
  armor?: number; // armor.condition (hit points left)
  perishDaysLeft?: number; // perishable.time / 480, one decimal
}

export interface RecapItem {
  prefab: string;
  name: string;
  count: number; // stack size, 1 when unstackable
  condition?: RecapItemCondition;
}

export interface RecapEquipped {
  slot: string; // 'hands' | 'head' | 'body' | …
  item: RecapItem;
}

export interface RecapCarrying {
  /** Inventory slots in slot order; empty slots omitted. */
  inventory: RecapItem[];
  equipped: RecapEquipped[];
  /** Contents of whatever is equipped with a container (backpack, piggyback, …); null if none. */
  backpack: { prefab: string; name: string; items: RecapItem[] } | null;
  /** Which shard's player file this came from (the player saves wherever they were last). */
  shard: RecapShard;
}

export interface RecapPosition {
  day: number;
  shard: RecapShard;
  /** Worldgen room name, e.g. "Rocky", "Forest", "BGGrass" → "Grass"; null if off-map. */
  biome: string | null;
  /** True when the position is within the base radius of the busiest structure cluster. */
  atBase: boolean;
}

export interface RecapPlayer {
  ref: string; // opaque, "p1", "p2", … — stable only within one recap
  persona: string | null; // in-game display name from the session logs
  character: string | null; // prefab, e.g. "wathgrithr"
  characterName: string | null; // "Wigfrid"
  presentBefore: boolean;
  presentAfter: boolean;
  /** Tiles stood on for the first time this session, per shard. Null = no map in both saves. */
  newTiles: Record<RecapShard, number | null>;
  totalTiles: Record<RecapShard, number | null>;
  /** Dawn positions from the save's daily snapshots (both shards, sorted by day). */
  dailyPositions: RecapPosition[];
  /** Where the player's newest save puts them at the stop. */
  lastPosition: RecapPosition | null;
  learned: RecapNamed[];
  carrying: RecapCarrying | null;
  deaths: number;
  revives: number;
  caveTrips: number;
  stats: { health: number | null; hunger: number | null; sanity: number | null } | null;
}

/** What is in the players' own storage at the stop, grouped by container kind and shard. Only
 *  player-built containers (placeable recipes) and followers (Chester, Hutch) are listed, so
 *  world-generated loot such as the unopened `terrariumchest` is never revealed. */
export interface RecapContainerGroup {
  prefab: string; // 'treasurechest', 'icebox', 'chester', …
  name: string;
  shard: RecapShard;
  containers: number; // how many of this kind on the shard
  items: RecapNamedCount[]; // `delta` holds the count here (the total, not a change)
}

export interface RecapDeath {
  player: string | null; // ref, null if the chat name matched no player
  persona: string;
  cause: string;
  minute: number; // minutes since the shard started (chat-log time)
  revivedBy: string | null; // persona
  revivedAfterMinutes: number | null;
}

export interface RecapSession {
  startedAt: string | null;
  joinableAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  /** stoppedAt − joinableAt (falls back to startedAt), whole minutes. */
  realMinutes: number | null;
  peakPlayers: number | null;
  startedBy: string | null; // allowlist nickname from manifest.json (already non-identifying)
  dstBuildId: string | null;
}

export interface RecapWorldTime {
  start: RecapCalendarPoint | null;
  end: RecapCalendarPoint | null;
  daysPassed: number | null;
  /** Season starts that fell inside the session, e.g. [{ season: 'summer', day: 56 }]. */
  seasonChanges: { season: string; day: number }[];
}

export interface Recap {
  schemaVersion: typeof RECAP_SCHEMA_VERSION;
  digestVersion: string;
  worldId: string;
  sessionId: string;
  generatedAt: string;
  hasCaves: boolean;
  session: RecapSession;
  /** The pre-session save is the previous session's post-session save. False = the world was
   *  restored or re-seeded in between, so the deltas below compare against that restore. */
  continuous: boolean | null;
  /** 'ok' = every section computed. 'partial' = the post-stop save was missing (e.g. a crash
   *  with `postStopVersionId: null`), so only the log-derived facts are present. */
  status: 'ok' | 'partial';
  notes: string[]; // human-readable caveats, e.g. "no post-stop save: deltas unavailable"
  time: RecapWorldTime;
  built: RecapNamedCount[];
  destroyed: RecapNamedCount[];
  storage: RecapNamedCount[];
  /** Contents at the stop (not a change); see `RecapContainerGroup`. */
  containers: RecapContainerGroup[];
  deaths: RecapDeath[];
  players: RecapPlayer[];
  /** The world's "next time" note as it stood when the digest ran (docs/decisions.md §18). */
  noteAtDigest: string | null;
}

/** `digest/players.json`: private, API-only. Never served. */
export interface RecapPlayersFile {
  schemaVersion: typeof RECAP_SCHEMA_VERSION;
  players: {
    ref: string;
    ku: string | null;
    steamId64: string | null;
    persona: string | null;
    /** The engine's hashed per-user save directory. Lets a later digest recognise a player whose
     *  session has no log lines for them (e.g. they did not join). */
    userdir: string | null;
  }[];
}

/** `digest/summary.json`: metadata for `digest/summary.md`. */
export type RecapSummaryMeta =
  | {
      status: 'ok';
      model: string;
      promptVersion: string;
      generatedAt: string;
      latencyMs: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
      };
      costUsd: number | null;
      /** Session ids whose summaries/digests were fed in for continuity. */
      contextSessions: string[];
    }
  | {
      status: 'unavailable';
      reason: 'no_api_key' | 'api_error' | 'timeout' | 'refusal' | 'empty' | 'disabled';
      detail: string | null; // never a secret
      promptVersion: string;
      generatedAt: string;
    };

// ---------------------------------------------------------------------------------------------
// API (docs/control-plane.md §5.4): what the browser gets. No KU, no SteamID64.
// ---------------------------------------------------------------------------------------------

/** A recap player as the browser sees it: `persona` plus the allowlist `nickname` if known. */
export type RecapPlayerView = RecapPlayer & { nickname: string | null };

export type RecapView = Omit<Recap, 'players'> & { players: RecapPlayerView[] };

export type RecapSummaryView =
  { status: 'ok'; text: string; model: string; promptVersion: string } | { status: 'unavailable' };

export interface RecapEntry {
  sessionId: string;
  recap: RecapView;
  summary: RecapSummaryView;
}

export interface WorldNote {
  text: string;
  updatedAt: string;
  updatedBy: string | null; // allowlist nickname, never a SteamID64
}

/** `GET /api/worlds/{id}/recaps?limit=N` */
export interface RecapsResponse {
  worldId: string;
  note: WorldNote | null;
  recaps: RecapEntry[]; // newest first
}

/** `POST /api/worlds/{id}/note` returns the stored note (null when cleared). */
export interface NoteResponse {
  note: WorldNote | null;
}

export const NOTE_MAX_CHARS = 200;
/** The note travels in this request header (URI-encoded) so the POST stays bodyless
 *  (docs/decisions.md §10: CloudFront OAC needs x-amz-content-sha256 for a body). */
export const NOTE_HEADER = 'x-dst-note';
export const RECAPS_DEFAULT_LIMIT = 3;
export const RECAPS_MAX_LIMIT = 10;

// ---------------------------------------------------------------------------------------------
// The per-player map (docs/decisions.md §19)
// ---------------------------------------------------------------------------------------------

/** The reveal: the visited trail dilated by this many tiles (a Euclidean disc). Route A of
 *  docs/research/map-inventory-recap.md §2.1, picked by eye against the in-game map; applied by
 *  the API, so changing it needs a deploy and no re-digest. */
export const MAP_REVEAL_RADIUS_TILES = 4;

/** File names under `sessions/<w>/<s>/digest/` that the digest writes and the API reads. */
export const MAP_INDEX_FILE = 'map/index.json';
export function mapTilesFile(shard: RecapShard): string {
  return `map/${shard}.tiles.gz`;
}
export function trailFile(ref: string, shard: RecapShard, kind: 'visited' | 'new'): string {
  return `trail/${ref}/${shard}.${kind}.bin`;
}

/** A tile on a shard's grid: `tx` column, `ty` row (row-major, row = y, as in the save). */
export interface MapTile {
  tx: number;
  ty: number;
}

/** A player-built container (or Chester/Hutch) on the map, with what is in it. */
export interface MapContainer extends MapTile {
  prefab: string;
  name: string;
  items: { prefab: string; name: string; count: number }[];
}

/** `digest/map/index.json`. Beside it, per shard, `digest/map/<shard>.tiles.gz`: gzip of
 *  `width*height` bytes, row-major, each a 1-based index into that shard's `palette` (0 unused).
 *  No identifiers: players are the refs of `recap.json`. */
export interface RecapMapIndex {
  schemaVersion: typeof RECAP_SCHEMA_VERSION;
  /** In-game day at the end of the session, and when it stopped (as in `recap.json`). */
  day: number | null;
  stoppedAt: string | null;
  shards: Partial<
    Record<
      RecapShard,
      {
        width: number;
        height: number;
        /** DST tile names (`FOREST`, `OCEAN_COASTAL`, …); byte value `i` is `palette[i - 1]`. */
        palette: string[];
        containers: MapContainer[];
        base: MapTile | null;
        /** player ref -> the tile they stopped on, for players whose save is on this shard. */
        stops: Record<string, MapTile>;
      }
    >
  >;
}

/** One shard of one player's map in `GET /api/worlds/{id}/map`, already cut to that player's
 *  reveal. */
export interface MapShardView {
  width: number;
  height: number;
  /** Only the tile types that are revealed; byte value `i` is `palette[i - 1]`, 0 = fog. */
  palette: string[];
  /** base64 of gzip of `width*height` bytes (row-major). */
  tiles: string;
  /** base64 of gzip of the visited bitmap: 1 bit per tile, MSB-first, row-major. */
  trail: string;
  /** Same format: the tiles first walked in `sessionId`. */
  fresh: string;
  freshCount: number;
  containers: MapContainer[];
  base: MapTile | null;
  /** Where that player stopped, if on this shard. */
  stop: MapTile | null;
}

/** One player's map as of their last session in this world. No identifier: the player is known
 *  only by `label`. */
export interface PlayerMap {
  /** Allowlist nickname, else their persona in that session, else 'Player'. */
  label: string;
  /** The signed-in viewer's own map. */
  isViewer: boolean;
  /** The session the map is from (that player's newest one with a map). */
  sessionId: string;
  stoppedAt: string | null;
  day: number | null;
  shards: Partial<Record<RecapShard, MapShardView>>;
}

/** `GET /api/worlds/{id}/map`: every player's map, each masked by its own player's reveal. */
export type MapResponse =
  | {
      status: 'ok';
      worldId: string;
      revealRadius: number;
      /** The viewer's first (when they have one), then by `stoppedAt`, newest first. */
      maps: PlayerMap[];
    }
  | { status: 'none'; worldId: string };
