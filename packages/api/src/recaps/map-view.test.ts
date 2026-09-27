// docs/decisions.md §19: the map's spoiler boundary. Synthetic grids only.
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { StoredMap } from '../ports';
import { bitAt, dilate, toMapResponse, toMapShardView } from './map-view';

function bits(width: number, height: number, tiles: [number, number][]): Uint8Array {
  const out = new Uint8Array(Math.ceil((width * height) / 8));
  for (const [tx, ty] of tiles) {
    const i = ty * width + tx;
    out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out;
}

const W = 16;
const H = 12;
/** Left half GRASS (2), right half ROCKY (3), top row OCEAN_COASTAL (1). */
function terrain(): Uint8Array {
  const g = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++)
    for (let tx = 0; tx < W; tx++) g[ty * W + tx] = ty === 0 ? 1 : tx < 8 ? 2 : 3;
  return g;
}
const INDEX_SHARD = {
  width: W,
  height: H,
  palette: ['OCEAN_COASTAL', 'GRASS', 'ROCKY'],
  containers: [
    {
      tx: 3,
      ty: 6,
      prefab: 'treasurechest',
      name: 'Chest',
      items: [{ prefab: 'log', name: 'Log', count: 5 }],
    },
    { tx: 14, ty: 6, prefab: 'icebox', name: 'Ice Box', items: [] },
  ],
  base: { tx: 3, ty: 7 },
  stops: { p1: { tx: 2, ty: 6 }, p2: { tx: 14, ty: 7 } },
};
type StoredShard = NonNullable<StoredMap['shards']['master']>;
const stored = (visited: Uint8Array, fresh: Uint8Array | null = null): StoredShard => ({
  tilesGz: gzipSync(terrain()),
  visited,
  fresh,
});

describe('dilate', () => {
  it('reveals tile centres within r + 1/2 of a visited tile', () => {
    const r = dilate(bits(11, 11, [[5, 5]]), 11, 11, 4);
    const at = (dx: number, dy: number) => r[(5 + dy) * 11 + 5 + dx];
    expect(at(4, 0)).toBe(1);
    expect(at(4, 2)).toBe(1); // 16 + 4 = 20 = r² + r
    expect(at(3, 3)).toBe(1);
    expect(at(4, 3)).toBe(0);
    expect(at(5, 0)).toBe(0);
    expect(r.reduce((a, b) => a + b, 0)).toBe(69);
  });

  it('clips at the edges', () => {
    const r = dilate(bits(4, 4, [[0, 0]]), 4, 4, 1);
    expect([...r]).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // r=1 is the full 3×3
  });
});

describe('toMapShardView', () => {
  const trail = bits(W, H, [
    [2, 6],
    [3, 6],
  ]);

  it('fogs everything outside the reveal and names only revealed tile types', () => {
    const v = toMapShardView(INDEX_SHARD, stored(trail), 'p1', 2)!;
    expect(v.palette).toEqual(['GRASS']); // no ocean, no rock within 2 tiles
    const grid = gunzipSync(Buffer.from(v.tiles, 'base64'));
    expect(grid[6 * W + 3]).toBe(1);
    expect(grid[6 * W + 14]).toBe(0);
    expect(grid[0]).toBe(0);
    expect(v.containers.map((c) => c.name)).toEqual(['Chest']);
    expect(v.base).toEqual({ tx: 3, ty: 7 });
    expect(v.stop).toEqual({ tx: 2, ty: 6 });
  });

  it("serves only the viewer's stop, and nothing outside the reveal", () => {
    const v = toMapShardView(INDEX_SHARD, stored(trail), 'p2', 2)!;
    expect(v.stop).toBeNull(); // p2 stopped at (14, 7): not revealed
    const none = toMapShardView(INDEX_SHARD, stored(trail), 'p9', 2)!;
    expect(none.stop).toBeNull();
  });

  it('keeps the stored palette order when compacting', () => {
    const wide = bits(W, H, [[7, 1]]);
    const v = toMapShardView(INDEX_SHARD, stored(wide), 'p1', 2)!;
    expect(v.palette).toEqual(['OCEAN_COASTAL', 'GRASS', 'ROCKY']);
  });

  it('new tiles are masked by the trail and counted', () => {
    const fresh = bits(W, H, [
      [3, 6],
      [10, 10], // not visited: cannot be "new"
    ]);
    const v = toMapShardView(INDEX_SHARD, stored(trail, fresh), 'p1', 2)!;
    expect(v.freshCount).toBe(1);
    const f = gunzipSync(Buffer.from(v.fresh, 'base64'));
    expect(bitAt(f, 6 * W + 3)).toBe(true);
    expect(bitAt(f, 10 * W + 10)).toBe(false);
  });

  it('rejects a malformed shard rather than drawing a wrong map', () => {
    const bad = (shard: unknown, s = stored(trail)) => toMapShardView(shard, s, 'p1', 2);
    expect(bad({ ...INDEX_SHARD, palette: ['grass'] })).toBeNull();
    expect(bad({ ...INDEX_SHARD, palette: ['GRASS'] })).toBeNull(); // grid values 2, 3 unnamed
    expect(bad({ ...INDEX_SHARD, width: 15 })).toBeNull();
    expect(bad({ ...INDEX_SHARD, width: 5000 })).toBeNull();
    expect(bad(INDEX_SHARD, { ...stored(trail), tilesGz: new Uint8Array([1, 2, 3]) })).toBeNull();
    expect(bad(INDEX_SHARD, { ...stored(trail), visited: new Uint8Array(3) })).toBeNull();
    expect(bad(null)).toBeNull();
  });

  it('drops malformed containers and redacts identifiers in names', () => {
    const v = toMapShardView(
      {
        ...INDEX_SHARD,
        containers: [
          {
            tx: 3,
            ty: 6,
            prefab: 'x',
            name: 'KU_ABCDEF chest',
            items: [{ prefab: 'log', count: -1 }],
          },
          { tx: 99, ty: 6, prefab: 'y' },
          { tx: 3, prefab: 'z' },
        ],
      },
      stored(trail),
      'p1',
      2,
    )!;
    expect(v.containers).toEqual([
      { tx: 3, ty: 6, prefab: 'x', name: '[redacted] chest', items: [] },
    ]);
  });
});

describe('toMapResponse', () => {
  const s = (visited: Uint8Array): StoredMap => ({
    sessionId: 's1',
    ref: 'p1',
    index: {
      schemaVersion: 1,
      day: 12,
      stoppedAt: '2026-01-01T00:00:00.000Z',
      shards: { master: INDEX_SHARD },
    },
    shards: { master: stored(visited) },
  });

  it('none without a stored map or with an empty trail', () => {
    expect(toMapResponse(null, 'w')).toEqual({ status: 'none', worldId: 'w' });
    expect(toMapResponse(s(new Uint8Array(Math.ceil((W * H) / 8))), 'w')).toEqual({
      status: 'none',
      worldId: 'w',
    });
  });

  it('ok with the session, the day and the radius', () => {
    const r = toMapResponse(s(bits(W, H, [[3, 6]])), 'w');
    expect(r).toMatchObject({ status: 'ok', sessionId: 's1', day: 12, revealRadius: 4 });
  });
});
