// @dst/supervisor core: the count-query line builder and log-line parser (docs/game-server.md §7,
// §12). Every signal (count replies, joinable, pause, shard loss) comes from one tailed log
// stream; these functions turn one line at a time into a typed result, or `null` when the line
// does not match.
import type { Shard, ShardReading } from './types';

/**
 * The nonce'd Lua line written to a shard's FIFO (docs/game-server.md §7 step 2). `<NONCE>` is
 * substituted with the decimal nonce; the server echoes the command verbatim first (see
 * `parseCountReply`), so the answer line and the echo line must be told apart.
 */
const COUNT_QUERY_TEMPLATE =
  'local ok,s,c,a = pcall(function() return ' +
  'TheWorld.shard.components.shard_players:GetNumPlayers(), #GetPlayerClientTable(), #AllPlayers ' +
  'end) print("DSTQ <NONCE> "..tostring(ok).." "..tostring(s).." "..tostring(c).." "..tostring(a))';

/** Builds the count-query Lua line for one nonce (docs/game-server.md §7 step 1-2). */
export function buildCountQueryLine(nonce: number): string {
  return COUNT_QUERY_TEMPLATE.replace('<NONCE>', String(nonce));
}

/** The server echoes the raw command back before running it; the echo contains the literal Lua
 *  source (including `"..tostring(ok).."`), which would otherwise false-match the answer regex
 *  (docs/game-server.md §7 step 3, spike §2). */
const REMOTE_COMMAND_ECHO_MARKER = 'RemoteCommandInput:';

/**
 * Parses one tailed log line as a reply to the count query for `nonce`. Returns `null` when the
 * line is not a reply to this nonce at all (including the `RemoteCommandInput:` echo, which is
 * dropped before matching). A trailing TAB after the last field is tolerated (`\S+`).
 */
export function parseCountReply(line: string, nonce: number): ShardReading | null {
  if (line.includes(REMOTE_COMMAND_ECHO_MARKER)) return null;

  const re = new RegExp(`DSTQ ${nonce} (true|false) (\\S+) (\\S+) (\\S+)`);
  const m = re.exec(line);
  if (!m) return null;

  const [, ok, shardplayersRaw, clientsRaw, allplayersRaw] = m;
  if (ok !== 'true') return { kind: 'unknown' };

  const shardplayers = Number(shardplayersRaw);
  const clients = Number(clientsRaw);
  const allplayers = Number(allplayersRaw);
  if (
    !Number.isInteger(shardplayers) ||
    !Number.isInteger(clients) ||
    !Number.isInteger(allplayers)
  ) {
    return { kind: 'unknown' };
  }
  return { kind: 'ok', shardplayers, clients, allplayers };
}

// -------------------------------------------------------------------------------------------
// Joinable predicate and other parsed lines (docs/game-server.md §7, exact regexes)
// -------------------------------------------------------------------------------------------

export const REGISTERED_RE = /^\[[0-9:]+\]: Server registered via geo DNS in (\S+)\s*$/;
/** Anchored on the shard **name**, not the id, which varies. */
export const CAVES_LINKED_RE = /^\[[0-9:]+\]: World \d+\(Caves\) is now connected\s*$/;
export const PAUSE_EDGE_RE = /^\[[0-9:]+\]: Sim (un)?paused\s*$/;
export const ONLINE_SERVER_STARTED_RE = /^\[[0-9:]+\]: Online Server Started on port: (\d+)\s*$/;
export const LOAD_BE_DONE_RE = /^\[[0-9:]+\]:\s+LOAD BE: done\s*$/;
export const SHARD_DISCONNECTED_RE =
  /^\[[0-9:]+\]: \[Shard\] A shard has disconnected: '(\w+)\(\d+\)'/;
export const SHUTTING_DOWN_RE = /^\[[0-9:]+\]: Shutting down\s*$/;
/**
 * The Master's lobby-listing broadcast failed. Measured in the spike (§5, "BLOCKER found on
 * boot 2"): the server keeps retrying every ~5 s, forever, and **every other local signal stays
 * healthy** — the Lua VM answers count queries, `Sim paused` is logged, and (with caves) the Caves
 * shard sits waiting for a handshake the Master will never complete. The one missing signal is
 * `Server registered via geo DNS`, so the joinable predicate can never become true and the boot
 * burns the full 15-minute timeout. The code in the capture group is what says which failure it
 * is; `E_ROWID_EXIST` is the one this project has actually hit (docs/game-server.md §13).
 */
export const MASTER_BROADCAST_ERROR_RE =
  /^\[[0-9:]+\]: \[Error\] Master Server Broadcast Error: (\S+)/;

export function isRegistered(line: string): boolean {
  return REGISTERED_RE.test(line);
}

export function isCavesLinked(line: string): boolean {
  return CAVES_LINKED_RE.test(line);
}

/** `true` for `Sim paused`, `false` for `Sim unpaused`, `null` when the line does not match (this
 *  is NOT the same as `Server Autopaused`, which never matches). */
export function parsePauseEdge(line: string): boolean | null {
  const m = PAUSE_EDGE_RE.exec(line);
  if (!m) return null;
  return m[1] === undefined; // no "un" captured -> "Sim paused" -> true
}

export function isLoadComplete(line: string): boolean {
  return LOAD_BE_DONE_RE.test(line);
}

export function isShuttingDown(line: string): boolean {
  return SHUTTING_DOWN_RE.test(line);
}

/** Returns the Klei error code of a failed lobby broadcast (e.g. `"E_ROWID_EXIST"`), or `null`
 *  when the line is not a broadcast error. The `[Http] Curl failed[1] with HTTP_500 ...` line that
 *  precedes it and the `Master Server Broadcast will try to broadcast a new listing.` line that
 *  follows it both return `null`: one error is counted once. */
export function parseMasterBroadcastError(line: string): string | null {
  return MASTER_BROADCAST_ERROR_RE.exec(line)?.[1] ?? null;
}

/** Returns the disconnected shard's name (e.g. `"Caves"`), or `null` when the line does not match. */
export function parseShardDisconnected(line: string): Shard | null {
  const m = SHARD_DISCONNECTED_RE.exec(line);
  if (!m) return null;
  const name = m[1];
  return name === 'Master' || name === 'Caves' ? name : null;
}

/** Parses the Steam build id out of `appmanifest_343050.acf` (docs/game-server.md §12). */
export function parseBuildId(acfContents: string): string | null {
  const m = /"buildid"\s+"(\d+)"/.exec(acfContents);
  return m?.[1] ?? null;
}
