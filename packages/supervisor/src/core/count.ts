// @dst/supervisor core: the player-count formula (docs/decisions.md §5, docs/game-server.md §7,
// §12). `shardplayers` (`shard_players:GetNumPlayers()`) is parsed everywhere but never fed into
// the formula: the spike measured it never decaying after a disconnect, which would be the most
// expensive possible bug in this system (an instance that never stops billing).
import type { ShardReading } from './types';

export interface ShardCounts {
  readonly shardplayers: number;
  readonly clients: number;
  readonly allplayers: number;
}

/**
 * `players = hasCaves ? max(master.clients, caves.clients, master.allplayers + caves.allplayers)
 *                      : max(master.clients, master.allplayers)`.
 * `caves` must be provided when `hasCaves` is true — the caller (idle.ts / index.ts) is
 * responsible for turning a `{kind:'unknown'}` shard reading into an overall UNKNOWN reading
 * before ever calling this function (docs/game-server.md §7: "If any polled shard reads unknown
 * the whole reading is UNKNOWN").
 */
export function computePlayerCount(
  hasCaves: boolean,
  master: ShardCounts,
  caves: ShardCounts | null,
): number {
  if (hasCaves) {
    if (caves === null) {
      throw new Error('computePlayerCount: caves counts are required when hasCaves is true');
    }
    return Math.max(master.clients, caves.clients, master.allplayers + caves.allplayers);
  }
  return Math.max(master.clients, master.allplayers);
}

/**
 * Turns two (or one) raw `ShardReading`s into either an overall player count or `'unknown'`
 * (docs/game-server.md §7: any `unknown` shard makes the whole reading UNKNOWN).
 */
export function computeOverallReading(
  hasCaves: boolean,
  master: ShardReading,
  caves: ShardReading | null,
): number | 'unknown' {
  if (master.kind === 'unknown') return 'unknown';
  if (hasCaves) {
    if (caves === null || caves.kind === 'unknown') return 'unknown';
    return computePlayerCount(hasCaves, master, caves);
  }
  return computePlayerCount(hasCaves, master, null);
}
