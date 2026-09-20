import { describe, expect, it } from 'vitest';

import { computeOverallReading, computePlayerCount } from '../src/core/count';
import type { ShardCounts } from '../src/core/count';

function counts(shardplayers: number, clients: number, allplayers: number): ShardCounts {
  return { shardplayers, clients, allplayers };
}

describe('computePlayerCount', () => {
  // The five measured states of spike §9 (docs/game-server.md §12).
  it('is 0 0 0 / 0 0 0 -> 0', () => {
    expect(computePlayerCount(true, counts(0, 0, 0), counts(0, 0, 0))).toBe(0);
  });

  it('surface 1 1 1 / 1 1 0 -> 1', () => {
    expect(computePlayerCount(true, counts(1, 1, 1), counts(1, 1, 0))).toBe(1);
  });

  it('caves 1 1 0 / 1 1 1 -> 1', () => {
    expect(computePlayerCount(true, counts(1, 1, 0), counts(1, 1, 1))).toBe(1);
  });

  it('mid-migration 1 1 0 / 1 1 0 -> 1', () => {
    expect(computePlayerCount(true, counts(1, 1, 0), counts(1, 1, 0))).toBe(1);
  });

  // Titled exactly per the execution plan (docs/game-server.md §12).
  it('player count ignores shard_players', () => {
    // shardplayers stuck at 1 after a disconnect (spike §9); clients/allplayers correctly at 0.
    expect(computePlayerCount(true, counts(1, 0, 0), counts(1, 0, 0))).toBe(0);
  });

  it('uses the hasCaves=false formula: max(master.clients, master.allplayers)', () => {
    expect(computePlayerCount(false, counts(5, 2, 1), null)).toBe(2);
    expect(computePlayerCount(false, counts(0, 0, 3), null)).toBe(3);
  });

  it('throws if hasCaves is true but no caves counts are given', () => {
    expect(() => computePlayerCount(true, counts(0, 0, 0), null)).toThrow();
  });
});

describe('computeOverallReading', () => {
  it('is unknown when the master reading is unknown', () => {
    expect(
      computeOverallReading(
        true,
        { kind: 'unknown' },
        { kind: 'ok', shardplayers: 1, clients: 1, allplayers: 1 },
      ),
    ).toBe('unknown');
  });

  it('is unknown when hasCaves and the caves reading is unknown', () => {
    expect(
      computeOverallReading(
        true,
        { kind: 'ok', shardplayers: 1, clients: 1, allplayers: 1 },
        { kind: 'unknown' },
      ),
    ).toBe('unknown');
  });

  it('is unknown when hasCaves and caves was never polled', () => {
    expect(
      computeOverallReading(true, { kind: 'ok', shardplayers: 0, clients: 0, allplayers: 0 }, null),
    ).toBe('unknown');
  });

  it('computes the count when every polled shard is ok', () => {
    expect(
      computeOverallReading(
        true,
        { kind: 'ok', shardplayers: 1, clients: 1, allplayers: 1 },
        { kind: 'ok', shardplayers: 1, clients: 1, allplayers: 0 },
      ),
    ).toBe(1);
  });

  it('ignores caves entirely when hasCaves is false', () => {
    expect(
      computeOverallReading(
        false,
        { kind: 'ok', shardplayers: 2, clients: 2, allplayers: 2 },
        null,
      ),
    ).toBe(2);
  });
});
