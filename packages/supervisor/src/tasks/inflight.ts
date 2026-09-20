// @dst/supervisor tasks: the 10-minute in-session safety copy (docs/game-server.md §8).
// `nice -n 19 ionice -c3`, no forced `c_save()`. Skipped if the previous copy is still running;
// failures are logged, never fatal.
import { packAndPushSave } from './savePush';
import type { ObjectPort } from '../core';
import type { Logger } from '../adapters/logger';

export interface InflightCopyInput {
  readonly worldId: string;
  readonly clusterDir: string;
  readonly outPath: string;
  readonly objects: ObjectPort;
  readonly logger: Logger;
}

export type InflightCopier = () => Promise<void>;

export function createInflightCopier(input: InflightCopyInput): InflightCopier {
  let running = false;
  return async function runInflightCopy(): Promise<void> {
    if (running) {
      input.logger.debug('inflight_copy_skipped_still_running', { worldId: input.worldId });
      return;
    }
    running = true;
    try {
      await packAndPushSave({
        clusterDir: input.clusterDir,
        outPath: input.outPath,
        key: `inflight/${input.worldId}/save.tar.zst`,
        objects: input.objects,
        lowPriority: true,
      });
    } catch (err) {
      input.logger.warn('inflight_copy_failed', { worldId: input.worldId, error: String(err) });
    } finally {
      running = false;
    }
  };
}
