// @dst/supervisor core: the Master's Klei lobby registration, when it will not take
// (docs/game-server.md §7, §13; spike §5 "BLOCKER found on boot 2"). Pure: decides *when* to say
// something and *when* to clear the per-session scratch, plus *which paths* that means;
// `src/index.ts` does the writing, the removing and the restart.
//
// Why this exists. `Server registered via geo DNS` is the real joinable gate. When the Master's
// lobby broadcast is refused it logs `[Error] Master Server Broadcast Error: <code>` and retries
// every ~5 s, forever, while every other signal stays healthy (both Lua VMs answer console
// queries, `Sim paused` is logged, the world is loaded, `systemctl is-active` says `active`) — so
// the supervisor sees a perfectly healthy cluster that simply never becomes joinable, and burns
// the full 15-minute boot timeout with nothing in `lastError` to say why.
//
// Two different situations produce it, and they want opposite responses. Measured in T5.2
// (docs/_first-boot-notes.md round 2):
//
//  1. **The previous session's lobby row has not been released yet.** Every session uses the same
//     Klei cluster token, and an in-place world switch re-registers seconds after the old world
//     logged `Removing server from lobby`. Nothing local can release that row: with the scratch
//     already deleted, `E_ROWID_EXIST` was still being returned three minutes later. The only
//     thing that works is to **wait** — which DST's own 5 s retry loop already does.
//  2. **The cluster is carrying another server's lobby identity** in `save/server_temp` +
//     `save/client_temp` + `save/cached_userid` (spike §5: a save tarball restored onto a new
//     public IP). Waiting never fixes that one; deleting those three and restarting the shards
//     did, instantly, on the first attempt.
//
// So: report early and cheaply, and only clear+restart after waiting long enough that (1) has had
// a fair chance. An early restart costs ~90 s of shard stop and start for nothing.
import type { Shard } from './types';

/** Paths, relative to a shard directory, that carry the server's lobby-listing identity
 *  (`__rowId` = `<host KU id>^<per-server suffix>`, spike §6). Identical to three of the save
 *  tarball's excludes — by construction, not by coincidence. */
export const LOBBY_SCRATCH_ENTRIES = [
  'save/server_temp',
  'save/client_temp',
  'save/cached_userid',
] as const;

/** Absolute paths to remove before restarting the shards, one set per started shard. */
export function lobbyScratchPaths(clusterDir: string, shards: readonly Shard[]): string[] {
  const paths: string[] = [];
  for (const shard of shards) {
    for (const entry of LOBBY_SCRATCH_ENTRIES) paths.push(`${clusterDir}/${shard}/${entry}`);
  }
  return paths;
}

/** Broadcast errors before the supervisor says so (log + `lastError`). The server retries every
 *  ~5 s, so this is ~15 s of failing registration: past a single transient HTTP blip, and early
 *  enough that the UI explains a slow start instead of showing a silent `starting`. */
export const LOBBY_REPORT_THRESHOLD = 3;

/** Broadcast errors before the scratch is cleared and the shards restarted — ~3 minutes of
 *  uninterrupted failure at the server's ~5 s cadence. Long enough that case (1) above, which no
 *  local action can shorten, has had its chance; short enough that two attempts and the wait
 *  between them still fit inside the 15-minute boot timeout. */
export const LOBBY_RECOVERY_THRESHOLD = 36;

/** At most this many clear-and-restarts per session. Two that both fail to register mean the
 *  problem is not the local scratch, and looping would only spend the rest of the boot budget on
 *  shard restarts; the boot timeout is then the correct outcome. */
export const MAX_LOBBY_RECOVERIES = 2;

export interface LobbyRegistrationState {
  /** Has the Master logged `Server registered via geo DNS` in this shard generation? */
  readonly registered: boolean;
  /** `Master Server Broadcast Error:` lines seen since the shards were last started. */
  readonly broadcastErrorCount: number;
  /** How many clear-and-restarts this session has already performed. */
  readonly recoveriesDone: number;
  /** Has this session already reported the failure (so it is said once, not every 2 s)? */
  readonly reported: boolean;
}

/** `true` the first time the broadcast has failed enough to be worth a log line and a
 *  `lastError`. Nothing is restarted on the strength of this. */
export function shouldReportLobbyFailure(state: LobbyRegistrationState): boolean {
  if (state.registered || state.reported) return false;
  return state.broadcastErrorCount >= LOBBY_REPORT_THRESHOLD;
}

/** `true` when waiting has plainly not worked and clearing the per-session scratch is worth the
 *  shard restart it costs. Never fires once registration has succeeded: a broadcast error *after*
 *  a successful registration is a listing refresh failing, not a stuck boot. */
export function shouldRecoverLobbyRegistration(state: LobbyRegistrationState): boolean {
  if (state.registered) return false;
  if (state.recoveriesDone >= MAX_LOBBY_RECOVERIES) return false;
  return state.broadcastErrorCount >= LOBBY_RECOVERY_THRESHOLD;
}
