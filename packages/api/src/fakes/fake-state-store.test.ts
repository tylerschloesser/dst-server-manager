// Sanity tests for the fake itself (docs/control-plane.md §5.1: "the in-memory state store
// evaluates conditions exactly as DynamoDB would and exposes a hook to interleave writes").
import { describe, expect, it } from 'vitest';

import { initialClusterState } from '@dst/shared';

import { FakeStateStore } from './fake-state-store';

describe('FakeStateStore', () => {
  it('get() on an absent item returns initialClusterState(), not a throw', async () => {
    const store = new FakeStateStore();
    expect(await store.get()).toEqual(initialClusterState());
    expect(store.peek()).toBeUndefined();
  });

  it('startFresh fails once the item is no longer stopped', async () => {
    const store = new FakeStateStore();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const ok1 = await store.startFresh({
      worldId: 'w1',
      sessionId: 's1',
      steamId64: 'u1',
      nickname: 'A',
      now,
    });
    expect(ok1).toBe(true);
    const ok2 = await store.startFresh({
      worldId: 'w1',
      sessionId: 's2',
      steamId64: 'u2',
      nickname: 'B',
      now,
    });
    expect(ok2).toBe(false);
    expect(store.peek()?.sessionId).toBe('s1'); // the second call never overwrote the first
  });

  it('interleaveAfterNextRead runs exactly once, on the next get()', async () => {
    const store = new FakeStateStore();
    let calls = 0;
    store.interleaveAfterNextRead((current) => {
      calls += 1;
      return current;
    });
    await store.get();
    await store.get();
    expect(calls).toBe(1);
  });
});
