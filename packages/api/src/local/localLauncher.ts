// The local dev server's fake launcher (docs/control-plane.md §5.5): a 1 s ticker that walks the
// state item `starting -> running -> stopping -> stopped` exactly as the real supervisor would
// (S1...S7), so every UI state is reachable without any AWS resource. Used only by `src/local.ts`.
import { newSessionId } from '@dst/shared';
import type { ClusterStateItem, StopReason } from '@dst/shared';

import type { FakeStateStore } from '../fakes/fake-state-store';
import type { FakeWorldRegistry } from '../fakes/fake-world-registry';
import type { LaunchInput, LaunchOutput, Launcher } from '../ports';

export interface LocalLauncherOptions {
  bootSeconds: number;
  stopSeconds: number;
  idleMinutesOverride: number; // 0 = use the world's own idleMinutes
  players: number[];
  launchFail: boolean;
  stale: boolean;
  tickMs: number;
}

export const DEFAULT_LOCAL_LAUNCHER_OPTIONS: LocalLauncherOptions = {
  bootSeconds: 12,
  stopSeconds: 8,
  idleMinutesOverride: 0,
  players: [0, 1, 2, 2, 1, 0],
  launchFail: false,
  stale: false,
  tickMs: 1000,
};

const PLAYER_STEP_MS = 5000;

export class LocalFakeLauncher implements Launcher {
  private opts: LocalLauncherOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootStartedAtMs: number | null = null;
  private stopStartedAtMs: number | null = null;
  private playersIndex = 0;
  private lastPlayersStepAtMs = 0;

  constructor(
    private readonly store: FakeStateStore,
    private readonly registry: FakeWorldRegistry,
    options: Partial<LocalLauncherOptions> = {},
  ) {
    this.opts = { ...DEFAULT_LOCAL_LAUNCHER_OPTIONS, ...options };
  }

  /** `/api/test/control` and the env vars both funnel through here. */
  configure(options: Partial<LocalLauncherOptions>): void {
    this.opts = { ...this.opts, ...options };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error(JSON.stringify({ event: 'local_launcher_tick_failed', err: String(err) }));
      });
    }, this.opts.tickMs);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async launch(input: LaunchInput): Promise<LaunchOutput> {
    void input;
    if (this.opts.launchFail) {
      const err = new Error('no capacity in any AZ (DST_LOCAL_LAUNCH_FAIL)');
      err.name = 'InsufficientInstanceCapacity';
      throw err;
    }

    this.bootStartedAtMs = Date.now();
    this.stopStartedAtMs = null;
    this.playersIndex = 0;
    this.lastPlayersStepAtMs = Date.now();

    const instanceId = 'i-local1';
    const publicIp = '203.0.113.10';
    const current = this.store.peek();
    if (current !== undefined) {
      this.store.setRaw({
        ...current,
        instanceId,
        publicIp,
        heartbeatAt: new Date().toISOString(),
      });
    }
    return { instanceId };
  }

  private async idleMinutesFor(item: ClusterStateItem): Promise<number> {
    if (this.opts.idleMinutesOverride > 0) return this.opts.idleMinutesOverride;
    const world = item.worldId !== null ? await this.registry.get(item.worldId) : null;
    return world?.idleMinutes ?? 30;
  }

  private async tick(): Promise<void> {
    const item = this.store.peek();
    if (item === undefined) return;
    const now = new Date();

    if (item.status === 'starting') {
      await this.tickStarting(item, now);
      return;
    }
    if (item.status === 'running') {
      await this.tickRunning(item, now);
      return;
    }
    if (item.status === 'stopping') {
      await this.tickStopping(item, now);
    }
  }

  private async tickStarting(item: ClusterStateItem, now: Date): Promise<void> {
    if (this.bootStartedAtMs === null) return;
    const elapsedMs = Date.now() - this.bootStartedAtMs;
    if (elapsedMs < this.opts.bootSeconds * 1000) return;

    const idleMinutes = await this.idleMinutesFor(item);
    this.store.setRaw({
      ...item,
      status: 'running',
      joinableAt: now.toISOString(),
      playerCount: 0,
      idleDeadline: new Date(now.getTime() + idleMinutes * 60_000).toISOString(),
      heartbeatAt: this.opts.stale ? item.heartbeatAt : now.toISOString(),
      lastError: null,
    });
  }

  private stopReasonFor(item: ClusterStateItem, now: Date): StopReason | null {
    if (item.desiredWorldId === null) return 'user';
    if (item.desiredWorldId !== item.worldId) return 'switch';
    if (item.idleDeadline !== null && Date.parse(item.idleDeadline) <= now.getTime()) return 'idle';
    return null;
  }

  private async tickRunning(item: ClusterStateItem, now: Date): Promise<void> {
    const idleMinutes = await this.idleMinutesFor(item);
    const next: ClusterStateItem = { ...item };

    if (!this.opts.stale) {
      next.heartbeatAt = now.toISOString();
    }

    if (Date.now() - this.lastPlayersStepAtMs >= PLAYER_STEP_MS && this.opts.players.length > 0) {
      this.lastPlayersStepAtMs = Date.now();
      const count = this.opts.players[this.playersIndex % this.opts.players.length] ?? 0;
      this.playersIndex += 1;
      next.playerCount = count;
      if (count > 0) {
        next.idleDeadline = new Date(now.getTime() + idleMinutes * 60_000).toISOString();
      }
    }

    const stopReason = this.stopReasonFor(next, now);
    if (stopReason !== null) {
      next.status = 'stopping';
      next.lastStopReason = stopReason;
      next.heartbeatAt = now.toISOString();
      this.stopStartedAtMs = Date.now();
    }

    this.store.setRaw(next);
  }

  private async tickStopping(item: ClusterStateItem, now: Date): Promise<void> {
    if (this.stopStartedAtMs === null) return;
    const elapsedMs = Date.now() - this.stopStartedAtMs;
    if (elapsedMs < this.opts.stopSeconds * 1000) return;

    if (item.desiredWorldId !== null) {
      // S5-equivalent: switch in place, same "instance", new session.
      this.store.setRaw({
        ...item,
        status: 'starting',
        worldId: item.desiredWorldId,
        sessionId: newSessionId(now),
        startedBy: item.desiredBy,
        startedByNickname: item.desiredByNickname,
        startedAt: now.toISOString(),
        joinableAt: null,
        playerCount: null,
        idleDeadline: null,
        lastStopReason: 'switch',
        heartbeatAt: now.toISOString(),
      });
      this.bootStartedAtMs = Date.now();
      this.stopStartedAtMs = null;
      return;
    }

    // S6-equivalent: final stopped.
    this.store.setRaw({
      ...item,
      status: 'stopped',
      sessionId: null,
      instanceId: null,
      publicIp: null,
      joinableAt: null,
      playerCount: null,
      idleDeadline: null,
      heartbeatAt: null,
    });
    this.stopStartedAtMs = null;
  }
}
