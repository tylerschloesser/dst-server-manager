// @dst/supervisor core: pure types (docs/game-server.md §1, §8). This module — and everything
// else in core/ — imports nothing from adapters/, nothing from an AWS SDK, never touches the
// filesystem or spawns a process, and never reads the wall clock directly: every timestamp/random
// value the core needs arrives as a plain argument from the (impure) caller in src/index.ts /
// src/tasks/ (a later task).
import type { ClusterStateItem, StopReason, WorldRegistryItem } from '@dst/shared';

/** One DST process. Caves is always stopped/queried before Master (docs/game-server.md §9). */
export type Shard = 'Master' | 'Caves';

/** docs/game-server.md §8: `boot -> installing -> starting -> running -> stopping -> (starting | halted)`. */
export type Phase = 'boot' | 'installing' | 'starting' | 'running' | 'stopping' | 'halted';

/** The outcome of one nonce'd count-query round trip against one shard (docs/game-server.md §7). */
export type ShardReading =
  | {
      readonly kind: 'ok';
      readonly shardplayers: number;
      readonly clients: number;
      readonly allplayers: number;
    }
  | { readonly kind: 'unknown' };

// -------------------------------------------------------------------------------------------
// The reconcile state machine (docs/game-server.md §8; expressions in docs/control-plane.md §2)
// -------------------------------------------------------------------------------------------

/** What the supervisor believes right now; the input/output of `reduce()`. */
export interface ReconcileState {
  readonly phase: Phase;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly worldId: string;
  readonly hasCaves: boolean;
  readonly desiredWorldId: string | null;
  readonly desiredBy: string | null;
  readonly desiredByNickname: string | null;
  /** The Master has logged `LOAD BE: done` this session — gates the save push (decisions §16.15). */
  readonly loadCompleted: boolean;
  /** Non-null once `phase === 'stopping'`. `next` is the world (if any) that should start once
   *  the stop finishes in place, instead of terminating. */
  readonly stopping: { readonly reason: StopReason; readonly next: string | null } | null;
}

export type ReconcileEvent =
  | { readonly type: 'orphan' }
  | {
      readonly type: 'desired-changed';
      readonly desiredWorldId: string | null;
      readonly desiredBy: string | null;
      readonly desiredByNickname: string | null;
    }
  | { readonly type: 'load-completed' }
  | { readonly type: 'shard-exited'; readonly shard: Shard }
  | { readonly type: 'boot-timeout' }
  | { readonly type: 'idle-timeout' }
  /** Shards are stopped and the stop-vs-push decision has been made; `newSessionId` is minted by
   *  the (impure) caller only when a switch will be committed. */
  | { readonly type: 'stop-complete'; readonly newSessionId: string | null }
  /** The final S6 write's `ConditionExpression` failed: someone asked for a world during shutdown
   *  (decisions §6, §16). `newSessionId` is minted by the caller. */
  | {
      readonly type: 's6-condition-failed';
      readonly desiredWorldId: string;
      readonly newSessionId: string;
    };

export interface WriteS4Command {
  readonly kind: 'S4';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly reason: StopReason;
}

export interface WriteS5Command {
  readonly kind: 'S5';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly newSessionId: string;
  readonly newWorldId: string;
  readonly desiredBy: string;
  readonly desiredByNickname: string;
}

export interface WriteS6Command {
  readonly kind: 'S6';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly reason: StopReason;
}

/** S8 — release the desire this session is serving, so a stop the supervisor decided on alone
 *  (`idle`, `crash`) can reach S6 instead of being read as "a world was requested during shutdown"
 *  and restarting the world that just timed out (docs/_first-boot-notes.md round 3). */
export interface WriteS8Command {
  readonly kind: 'S8';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly worldId: string;
}

export type WriteCommand = WriteS4Command | WriteS5Command | WriteS6Command | WriteS8Command;

export type ReconcileCommand =
  | { readonly type: 'halt' } // orphan at boot: shutdown -h now, zero writes
  | { readonly type: 'start-shards'; readonly shards: readonly Shard[] }
  | { readonly type: 'stop-shards'; readonly shards: readonly Shard[] } // ordered, Caves first
  | { readonly type: 'push-save' }
  | { readonly type: 'upload-logs' }
  | { readonly type: 'shutdown' }
  | { readonly type: 'write'; readonly write: WriteCommand };

// -------------------------------------------------------------------------------------------
// Ports (docs/game-server.md §8): declared here, implemented in adapters/, faked in tests. core/
// depends only on these interfaces, never on a concrete AWS/fs/systemd implementation. A later
// task (adapters/, tasks/) implements them and translates a `WriteCommand` into the matching
// `@dst/shared` `state-expressions.ts` builder call.
// -------------------------------------------------------------------------------------------

/** A value that must never be logged or serialized in full (docs/game-server.md §10). */
export interface Secret {
  reveal(): string;
  toString(): '***';
  toJSON(): '***';
}

export interface ClockPort {
  now(): Date;
}

/** GetItem/UpdateItem on `pk="STATE" sk="CLUSTER"` (docs/control-plane.md §2). */
export interface StatePort {
  getState(): Promise<ClusterStateItem>;
  /** Resolves `false` on a `ConditionalCheckFailedException`, `true` otherwise; never throws for
   *  that one case. */
  write(command: WriteCommand): Promise<boolean>;
}

export interface RegistryPort {
  getWorld(worldId: string): Promise<WorldRegistryItem | null>;
}

export interface ObjectPort {
  getObject(key: string): Promise<{ body: NodeJS.ReadableStream; versionId: string | null } | null>;
  putObject(
    key: string,
    body: NodeJS.ReadableStream | Buffer,
  ): Promise<{ versionId: string | null }>;
}

export interface SecretPort {
  getClusterPassword(): Promise<Secret>;
  getKleiToken(): Promise<Secret>;
}

export interface ShardPort {
  start(shard: Shard): Promise<void>;
  stop(shard: Shard): Promise<void>;
  isActive(shard: Shard): Promise<boolean>;
  /** `dst-console <Shard> '<lua>'` (docs/game-server.md §7) — never a direct FIFO open. */
  writeConsole(shard: Shard, lua: string): Promise<void>;
}

export interface MetaPort {
  /** IMDSv2: instance-id, public-ipv4, instance-type, tags/instance/sessionId. */
  getIdentity(): Promise<{
    instanceId: string;
    publicIp: string;
    instanceType: string;
    sessionIdTag: string;
  }>;
}

export interface HostPort {
  shutdownNow(): Promise<void>;
}

/** The one runtime Route 53 record this project owns (docs/decisions.md §17, docs/infra.md §4.4):
 *  `JOIN_HOSTNAME` -> this instance's public IP on boot, -> `JOIN_DNS_SINK_IP` on every halt. One
 *  `UPSERT`, so no call ever needs to know the record's current value. The instance role is
 *  IAM-scoped to exactly this name and type — it cannot touch anything else in the shared zone. */
export interface DnsPort {
  setJoinRecord(ip: string): Promise<void>;
}
