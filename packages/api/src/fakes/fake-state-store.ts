// In-memory StateStore fake (docs/control-plane.md §5.1): "the in-memory state store evaluates
// conditions exactly as DynamoDB would and exposes a hook to interleave writes for the race
// tests." Shared by `local.ts` and the unit tests.
//
// Each conditional method below runs its condition check and mutation in one synchronous step (no
// `await` inside), which is what makes `Promise.all([...])` over two calls into this store
// faithfully reproduce a real DynamoDB race: both callers' `get()`s resolve with the
// pre-mutation snapshot before either's write can run, then whichever write commits first wins and
// the other's condition fails, exactly like two conditional `UpdateItem`s hitting the same item.
//
// `interleaveAfterNextRead` covers races this package cannot otherwise simulate — a write from an
// actor outside this package's ports (the supervisor's S5/S6) landing between the API's read and
// its own write.
import { initialClusterState } from '@dst/shared';
import type { ClusterStateItem } from '@dst/shared';

import type {
  StateStore,
  StateStoreClearDesiredInput,
  StateStoreFinalizeStoppedInput,
  StateStoreMaxAgeGracefulInput,
  StateStoreRollbackLaunchInput,
  StateStoreSetDesiredInput,
  StateStoreStartFreshInput,
} from '../ports';

type Interleave = (current: ClusterStateItem | undefined) => ClusterStateItem | undefined;

export class FakeStateStore implements StateStore {
  private item: ClusterStateItem | undefined;
  private interleaveQueue: Interleave[] = [];

  constructor(initial?: ClusterStateItem) {
    this.item = initial;
  }

  /**
   * Test-only. Queues a function that runs once, immediately after the *next* `get()` resolves,
   * receiving (and replacing) the raw item — simulating another actor's write landing in the gap
   * between this caller's read and its own conditional write.
   */
  interleaveAfterNextRead(fn: Interleave): void {
    this.interleaveQueue.push(fn);
  }

  /** Test-only: inspect the raw item. */
  peek(): ClusterStateItem | undefined {
    return this.item ? { ...this.item } : undefined;
  }

  /** Test-only / local.ts: replace the raw item directly. */
  setRaw(item: ClusterStateItem | undefined): void {
    this.item = item;
  }

  async get(): Promise<ClusterStateItem> {
    const snapshot = this.item ? { ...this.item } : initialClusterState();
    const next = this.interleaveQueue.shift();
    if (next) {
      this.item = next(this.item ? { ...this.item } : undefined);
    }
    return snapshot;
  }

  async startFresh(a: StateStoreStartFreshInput): Promise<boolean> {
    if (this.item !== undefined && this.item.status !== 'stopped') return false;
    this.item = {
      ...initialClusterState(),
      status: 'starting',
      worldId: a.worldId,
      desiredWorldId: a.worldId,
      desiredBy: a.steamId64,
      desiredByNickname: a.nickname,
      desiredAt: a.now.toISOString(),
      sessionId: a.sessionId,
      startedBy: a.steamId64,
      startedByNickname: a.nickname,
      startedAt: a.now.toISOString(),
    };
    return true;
  }

  async setDesired(a: StateStoreSetDesiredInput): Promise<boolean> {
    if (this.item === undefined) return false;
    if (this.item.status !== a.expectedStatus) return false;
    if (this.item.sessionId !== a.expectedSessionId) return false;
    this.item = {
      ...this.item,
      desiredWorldId: a.worldId,
      desiredBy: a.steamId64,
      desiredByNickname: a.nickname,
      desiredAt: a.now.toISOString(),
    };
    return true;
  }

  async clearDesired(a: StateStoreClearDesiredInput): Promise<boolean> {
    if (this.item === undefined) return false;
    if (this.item.worldId !== a.worldId) return false;
    if (this.item.status === 'stopped') return false;
    this.item = {
      ...this.item,
      desiredWorldId: null,
      desiredBy: a.steamId64,
      desiredByNickname: a.nickname,
      desiredAt: a.now.toISOString(),
    };
    return true;
  }

  async rollbackLaunch(a: StateStoreRollbackLaunchInput): Promise<boolean> {
    if (this.item === undefined) return false;
    if (this.item.sessionId !== a.sessionId) return false;
    if (this.item.status !== 'starting') return false;
    this.item = {
      ...this.item,
      status: 'stopped',
      desiredWorldId: null,
      sessionId: null,
      instanceId: null,
      publicIp: null,
      lastStopReason: 'launch-failed',
      lastError: a.error,
    };
    return true;
  }

  /** R1 — max-age graceful (docs/control-plane.md §2). */
  async maxAgeGraceful(a: StateStoreMaxAgeGracefulInput): Promise<boolean> {
    if (this.item === undefined) return false;
    if (this.item.sessionId !== a.sessionId) return false;
    if (this.item.instanceId !== a.instanceId) return false;
    if (this.item.status === 'stopped') return false;
    this.item = {
      ...this.item,
      desiredWorldId: null,
      desiredBy: 'reaper',
      desiredByNickname: 'reaper',
      desiredAt: a.now.toISOString(),
      lastStopReason: 'reaper-max-age',
    };
    return true;
  }

  /** R2 (post-terminate) / R3 (reconcile) — same shape as S6 plus nulling the desire and
   *  recording why (docs/control-plane.md §2). */
  async finalizeStopped(a: StateStoreFinalizeStoppedInput): Promise<boolean> {
    if (this.item === undefined) return false;
    if (this.item.sessionId !== a.sessionId) return false;
    this.item = {
      ...this.item,
      status: 'stopped',
      sessionId: null,
      instanceId: null,
      publicIp: null,
      joinableAt: null,
      playerCount: null,
      idleDeadline: null,
      heartbeatAt: null,
      lastStopReason: a.reason,
      desiredWorldId: null,
      lastError: a.error,
    };
    return true;
  }
}
