// Reaper logic (docs/control-plane.md §6, docs/decisions.md §7, §16.13-§16.15). All rules live
// here; `src/handlers/reaper.ts` is a three-line Lambda entry that wires the real adapters and
// calls `runReaper`. This is the compile-ready stub for T2.1 — T2.3 replaces the body.
import type { StopReason } from '@dst/shared';

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

export interface ReaperDeps {
  store: StateStore; // plus the reaper's R1/R2/R3 conditional writes
  ec2: ReaperEc2;
  clock: Clock;
}

export interface ReaperResult {
  nulledDesire: string[]; // instance ids given the graceful R1
  terminated: { instanceId: string; reason: StopReason }[];
  reconciled: boolean; // whether R3 ran
}

export interface ReaperEvent {
  now?: string;
}

const NOT_IMPLEMENTED =
  'not implemented: T2.3 replaces src/reaper/index.ts (docs/control-plane.md §6)';

export async function runReaper(event: ReaperEvent, deps: ReaperDeps): Promise<ReaperResult> {
  void event;
  void deps;
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}
