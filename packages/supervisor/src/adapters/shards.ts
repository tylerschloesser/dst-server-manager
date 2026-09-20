// @dst/supervisor adapters: systemd + FIFO, through the `assets/bin/*` helpers
// (docs/game-server.md §6). Never a direct FIFO open — `dst-console` carries the `[ -p ]` test and
// the `timeout 5` (docs/game-server.md §7). Every call uses `execFile` with an argv array, never a
// shell string, so no value here is ever re-interpreted by a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Shard, ShardPort } from '../core';

const execFileAsync = promisify(execFile);

export function unitName(shard: Shard): string {
  return `dst-${shard.toLowerCase()}.service`;
}

export function createShardAdapter(): ShardPort {
  return {
    async start(shard: Shard): Promise<void> {
      await execFileAsync('systemctl', ['start', unitName(shard)]);
    },
    async stop(shard: Shard): Promise<void> {
      // docs/game-server.md §9 step 1: the outer `timeout` is a backstop in front of the unit's
      // own `TimeoutStopSec=200` / `dst-stop` ExecStop dance.
      await execFileAsync('timeout', ['240', 'systemctl', 'stop', unitName(shard)]);
    },
    async isActive(shard: Shard): Promise<boolean> {
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', unitName(shard)]);
        return stdout.trim() === 'active';
      } catch {
        // `systemctl is-active` exits non-zero for `failed`/`inactive`/unknown — never throw.
        return false;
      }
    },
    async writeConsole(shard: Shard, lua: string): Promise<void> {
      await execFileAsync('/usr/local/bin/dst-console', [shard, lua]);
    },
  };
}
