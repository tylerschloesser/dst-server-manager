// Reaper logic (docs/control-plane.md §6, docs/decisions.md §7, §16.13-§16.15). All rules live
// here; `src/handlers/reaper.ts` is a three-line Lambda entry that wires the real adapters and
// calls `runReaper`. Nothing here touches the AWS SDK directly — it takes ports, exactly as §5.1
// does.
import {
  JOIN_DNS_SINK_IP,
  MAX_SESSION_GRACE_MS,
  MAX_SESSION_MS,
  REAPER_BOOT_GRACE_MS,
  REAPER_HEARTBEAT_STALE_MS,
  STARTING_WITHOUT_INSTANCE_MS,
} from '@dst/shared';
import type { ClusterStateItem, StopReason } from '@dst/shared';

import type { Clock, StateStore } from '../ports';

export interface ReaperInstance {
  instanceId: string;
  launchTime: Date;
  sessionIdTag: string | null;
}

export interface ReaperEc2 {
  describeGameInstances(): Promise<ReaperInstance[]>;
  terminate(instanceId: string): Promise<void>;
}

/**
 * The backstop half of the stable join record (docs/decisions.md §17, docs/game-server.md §9).
 * The supervisor sinks `JOIN_HOSTNAME` itself on every stop it reaches, but an instance that dies
 * without getting an AWS call out — `dst-panic.service`'s poweroff, the dead-man `shutdown`, a
 * hard crash, or this reaper terminating it — leaves the record pointing at an address AWS is
 * free to hand to a stranger. So the reaper sinks it too, on every tick that ends a session.
 * Same one-method shape as the supervisor's `DnsPort`.
 */
export interface ReaperDns {
  setJoinRecord(ip: string): Promise<void>;
}

/**
 * The reaper's view of the state store: `StateStore.get()` (§5.1) plus the R1/R2/R3 conditional
 * writes (§2, §6). `packages/api/src/ports.ts`'s `StateStore` does not define R1/R2/R3 — those
 * writes are unique to the reaper (the API and the supervisor never issue them) — so this
 * interface adds them rather than widening `StateStore` itself. Whatever object backs this in
 * production (`src/handlers/reaper.ts`, out of this task's owned paths) must implement both
 * `StateStore` and these two methods against the same DynamoDB item, using the pure builders
 * `r1MaxAgeGraceful` / `r2PostTerminate` / `r3Reconcile` already exported by `@dst/shared`
 * (`state-expressions.ts`) — they are not yet wired to an adapter.
 */
export interface ReaperStore extends Pick<StateStore, 'get'> {
  /** R1 — max-age graceful: null the desire, record `reaper-max-age`. No terminate this tick. */
  maxAgeGraceful(a: { sessionId: string; instanceId: string; now: Date }): Promise<boolean>;
  /**
   * R2 (post-terminate) / R3 (reconcile) — same shape as S6 plus nulling the desire and recording
   * why. `sessionId` is the session this write is scoped to: for a tracked (non-orphan) instance
   * or a reconcile, that is `state.sessionId`; for a genuine orphan it is the orphan's own launch
   * `sessionId` tag, which by construction cannot equal the current `state.sessionId` — so the
   * write is a guaranteed no-op unless state has since converged onto that session, exactly the
   * "conditional on the session the reaper observed" idempotency the doc requires.
   */
  finalizeStopped(a: {
    sessionId: string;
    reason: Extract<StopReason, 'reaper-max-age' | 'reaper-stale'>;
    error: string;
  }): Promise<boolean>;
}

export interface ReaperDeps {
  store: ReaperStore;
  ec2: ReaperEc2;
  dns: ReaperDns;
  clock: Clock;
}

export interface ReaperResult {
  nulledDesire: string[]; // instance ids given the graceful R1
  terminated: { instanceId: string; reason: StopReason }[];
  reconciled: boolean; // whether R3 ran
  joinRecordSunk: boolean; // whether JOIN_HOSTNAME was pointed back at JOIN_DNS_SINK_IP
}

export interface ReaperEvent {
  now?: string;
}

function parseTimeOrNull(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True only when BOTH the instance id and the launch-session tag fail to match state (decisions
 *  §16.7): an in-place switch changes `state.sessionId` while keeping the instance, so a switched
 *  instance still matches on `instanceId` and is never an orphan. */
function isOrphan(instance: ReaperInstance, state: ClusterStateItem): boolean {
  return instance.instanceId !== state.instanceId && instance.sessionIdTag !== state.sessionId;
}

export async function runReaper(event: ReaperEvent, deps: ReaperDeps): Promise<ReaperResult> {
  const { store, ec2, dns, clock } = deps;

  // The override may only move time forward (decisions §16.13), so a bug in the event payload can
  // only make the reaper more aggressive, never less.
  const realNowMs = clock.now().getTime();
  const eventNowMs = event.now === undefined ? NaN : Date.parse(event.now);
  const nowMs = Math.max(realNowMs, Number.isNaN(eventNowMs) ? 0 : eventNowMs);
  const now = new Date(nowMs);

  const state = await store.get();
  const instances = await ec2.describeGameInstances();

  const result: ReaperResult = {
    nulledDesire: [],
    terminated: [],
    reconciled: false,
    joinRecordSunk: false,
  };
  const terminatedIds = new Set<string>();

  // At most one Route 53 call per run, on the branches that end a session, and never on a no-op
  // tick. Reaping must never fail because of DNS: the record is a convenience, the terminate and
  // the state write are the cost backstop (CLAUDE.md "Cost safety"), so a failure here is logged
  // and swallowed — the next tick that ends a session tries again.
  let sinkAttempted = false;
  const sinkJoinRecord = async (): Promise<void> => {
    if (sinkAttempted) return;
    sinkAttempted = true;
    try {
      await dns.setJoinRecord(JOIN_DNS_SINK_IP);
      result.joinRecordSunk = true;
    } catch (err) {
      console.log(JSON.stringify({ event: 'reaper_join_dns_failed', error: String(err) }));
    }
  };

  for (const instance of instances) {
    const ageMs = nowMs - instance.launchTime.getTime();

    // 1. orphan
    if (isOrphan(instance, state)) {
      await ec2.terminate(instance.instanceId);
      terminatedIds.add(instance.instanceId);
      await sinkJoinRecord();
      result.terminated.push({ instanceId: instance.instanceId, reason: 'reaper-stale' });
      if (instance.sessionIdTag !== null) {
        await store.finalizeStopped({
          sessionId: instance.sessionIdTag,
          reason: 'reaper-stale',
          error: 'reaper: orphan instance terminated',
        });
      }
      continue;
    }

    // 2. max age, hard
    if (ageMs > MAX_SESSION_MS + MAX_SESSION_GRACE_MS) {
      await ec2.terminate(instance.instanceId);
      terminatedIds.add(instance.instanceId);
      await sinkJoinRecord();
      result.terminated.push({ instanceId: instance.instanceId, reason: 'reaper-max-age' });
      if (state.sessionId !== null) {
        await store.finalizeStopped({
          sessionId: state.sessionId,
          reason: 'reaper-max-age',
          error: 'reaper: max session age exceeded',
        });
      }
      continue;
    }

    // 3. max age, graceful (no terminate this tick — the supervisor saves and shuts down cleanly)
    if (ageMs > MAX_SESSION_MS && state.desiredWorldId !== null) {
      if (state.sessionId !== null) {
        const ok = await store.maxAgeGraceful({
          sessionId: state.sessionId,
          instanceId: instance.instanceId,
          now,
        });
        if (ok) result.nulledDesire.push(instance.instanceId);
      }
      continue;
    }

    // 4. stale heartbeat
    const heartbeatMs = parseTimeOrNull(state.heartbeatAt);
    const heartbeatStale = heartbeatMs === null || nowMs - heartbeatMs > REAPER_HEARTBEAT_STALE_MS;
    if (ageMs > REAPER_BOOT_GRACE_MS && heartbeatStale) {
      await ec2.terminate(instance.instanceId);
      terminatedIds.add(instance.instanceId);
      await sinkJoinRecord();
      result.terminated.push({ instanceId: instance.instanceId, reason: 'reaper-stale' });
      if (state.sessionId !== null) {
        await store.finalizeStopped({
          sessionId: state.sessionId,
          reason: 'reaper-stale',
          error: 'reaper: stale heartbeat',
        });
      }
    }
  }

  // Reconcile: state says something should be running but no live instance backs it up.
  if (state.status !== 'stopped') {
    const hasLiveMatch = instances.some(
      (i) =>
        !terminatedIds.has(i.instanceId) &&
        (i.instanceId === state.instanceId || i.sessionIdTag === state.sessionId),
    );
    const startedAtMs = parseTimeOrNull(state.startedAt);
    const startingTooYoung =
      state.status === 'starting' &&
      startedAtMs !== null &&
      nowMs - startedAtMs <= STARTING_WITHOUT_INSTANCE_MS;

    if (!hasLiveMatch && !startingTooYoung) {
      result.reconciled = true;
      // The branch that covers a death with no AWS call out: state said a world was up, nothing
      // backs it any more, so whatever the record says is stale by construction.
      await sinkJoinRecord();
      if (state.sessionId !== null) {
        await store.finalizeStopped({
          sessionId: state.sessionId,
          reason: 'reaper-stale',
          error: 'reaper: reconciled — no live instance',
        });
      }
    }
  }

  return result;
}
