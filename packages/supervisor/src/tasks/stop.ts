// @dst/supervisor tasks: the stop sequence, shard level (docs/game-server.md §9). Per shard,
// Caves first (`core/reduce.ts`'s `stopOrder`): `timeout 240 systemctl stop dst-<shard>.service`.
// Each unit's own `ExecStop` (`assets/bin/dst-stop`) does the FIFO `c_shutdown`/wait/SIGTERM/
// SIGKILL dance; a non-zero exit here is logged, never fatal — only a failure *before*
// `Shutting down` is data loss, and that is unobservable from the exit code alone.
import type { Shard, ShardPort } from '../core';
import { stopOrder } from '../core';
import type { Logger } from '../adapters/logger';

export interface StopShardsInput {
  readonly shards: readonly Shard[];
  readonly shardPort: ShardPort;
  readonly logger: Logger;
}

export async function stopShardsInOrder(input: StopShardsInput): Promise<void> {
  for (const shard of stopOrder(input.shards)) {
    try {
      await input.shardPort.stop(shard);
    } catch (err) {
      input.logger.warn('shard_stop_nonzero_exit', { shard, error: String(err) });
    }
  }
}
