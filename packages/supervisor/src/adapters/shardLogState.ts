// @dst/supervisor adapters: per-shard derived state fed by a `LogTailer` (docs/game-server.md §7).
// Every signal the loop needs — joinable clauses, the pause cross-check, count-query replies, a
// shard disconnect — comes from this one tailed stream, turned into typed flags by `core/parse.ts`.
import {
  isCavesLinked,
  isLoadComplete,
  isRegistered,
  isShuttingDown,
  parseCountReply,
  parsePauseEdge,
  parseShardDisconnected,
} from '../core';
import type { Shard, ShardReading } from '../core';

const MAX_RECENT_LINES = 500;

export class ShardLogState {
  registered = false;
  cavesLinked = false;
  /** Most recent anchored `Sim (un)paused` edge; `null` until one has been seen. */
  pauseEdge: boolean | null = null;
  loadCompleted = false;
  shuttingDownSeen = false;
  readonly disconnected = new Set<Shard>();

  private readonly recentLines: string[] = [];

  onLine(line: string): void {
    if (isRegistered(line)) this.registered = true;
    if (isCavesLinked(line)) this.cavesLinked = true;
    const pause = parsePauseEdge(line);
    if (pause !== null) this.pauseEdge = pause;
    if (isLoadComplete(line)) this.loadCompleted = true;
    if (isShuttingDown(line)) this.shuttingDownSeen = true;
    const disconnected = parseShardDisconnected(line);
    if (disconnected !== null) this.disconnected.add(disconnected);

    this.recentLines.push(line);
    if (this.recentLines.length > MAX_RECENT_LINES) this.recentLines.shift();
  }

  /** Scans the recent-lines buffer for a reply to `nonce`, most recent first. */
  findCountReply(nonce: number): ShardReading | null {
    for (let i = this.recentLines.length - 1; i >= 0; i--) {
      const reading = parseCountReply(this.recentLines[i] ?? '', nonce);
      if (reading !== null) return reading;
    }
    return null;
  }
}
