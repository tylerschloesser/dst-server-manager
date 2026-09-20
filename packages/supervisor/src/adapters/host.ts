// @dst/supervisor adapters: ending the instance's life (docs/game-server.md §8, §9 step 7).
// `InstanceInitiatedShutdownBehavior=terminate` (docs/infra.md) is what turns this into a real
// termination; the supervisor itself only ever calls `shutdown -h now`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { HostPort } from '../core';

const execFileAsync = promisify(execFile);

export function createHostAdapter(): HostPort {
  return {
    async shutdownNow(): Promise<void> {
      await execFileAsync('shutdown', ['-h', 'now']);
    },
  };
}
