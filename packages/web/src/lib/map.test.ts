// docs/web.md §3 Map: the map's pure half (colours, decode, paint, view maths, tap hit-testing).
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { MapContainer, MapShardView } from '@dst/shared';

import {
  FOG_RGB,
  FRESH_RGB,
  MAX_SCALE,
  UNKNOWN_TILE_RGB,
  centreOn,
  containerText,
  containersNear,
  decodeShard,
  fitView,
  inflateBase64,
  mapAsOfText,
  paintTerrain,
  revealedBounds,
  screenToTile,
  tileColor,
  zoomAt,
} from './map';

const b64gz = (bytes: number[] | Uint8Array) => gzipSync(Uint8Array.from(bytes)).toString('base64');

function view(over: Partial<MapShardView> = {}): MapShardView {
  // 4×2: row 0 fog, GRASS, GRASS, fog; row 1 fog, ROCKY, fog, fog
  return {
    width: 4,
    height: 2,
    palette: ['GRASS', 'ROCKY'],
    tiles: b64gz([0, 1, 1, 0, 0, 2, 0, 0]),
    trail: b64gz([0b01000000]), // tile 1
    fresh: b64gz([0b00100000]), // tile 2
    freshCount: 1,
    containers: [],
    base: null,
    stop: null,
    ...over,
  };
}

describe('tileColor', () => {
  it('matches by prefix, most specific first; unknown tiles are neutral', () => {
    expect(tileColor('OCEAN_COASTAL_SHORE')).not.toEqual(tileColor('OCEAN_COASTAL'));
    expect(tileColor('OCEAN_SOMETHING_NEW')).toEqual(tileColor('OCEAN_SWELL'));
    expect(tileColor('FUNGUSRED')).not.toEqual(tileColor('FUNGUS'));
    expect(tileColor('CAVE')).not.toEqual(UNKNOWN_TILE_RGB);
    expect(tileColor('NOT_A_TILE_YET')).toEqual(UNKNOWN_TILE_RGB);
  });
});

describe('decode', () => {
  it('inflates base64 gzip', async () => {
    expect([...(await inflateBase64(b64gz([1, 2, 255])))]).toEqual([1, 2, 255]);
  });

  it('decodes a shard and refuses mismatched sizes', async () => {
    const d = await decodeShard(view());
    expect([...d.tiles]).toEqual([0, 1, 1, 0, 0, 2, 0, 0]);
    await expect(decodeShard(view({ width: 5 }))).rejects.toThrow(/sizes/);
  });
});

describe('paintTerrain', () => {
  it('fog, palette colours, the trail lightened, new tiles red', async () => {
    const d = await decodeShard(view());
    const px = (p: Uint8ClampedArray, i: number) => [...p.slice(i * 4, i * 4 + 3)];
    const plain = paintTerrain(d, { trail: false, fresh: false });
    expect(px(plain, 0)).toEqual([...FOG_RGB]);
    expect(px(plain, 1)).toEqual([...tileColor('GRASS')]);
    expect(px(plain, 5)).toEqual([...tileColor('ROCKY')]);
    expect(plain[3]).toBe(255);
    const layered = paintTerrain(d, { trail: true, fresh: true });
    expect(px(layered, 1)).not.toEqual([...tileColor('GRASS')]); // trail
    expect(px(layered, 1)[0]).toBeGreaterThan(tileColor('GRASS')[0]);
    expect(px(layered, 2)).toEqual([...FRESH_RGB]);
    expect(px(layered, 0)).toEqual([...FOG_RGB]);
  });
});

describe('view maths', () => {
  it('revealedBounds is the box of non-fog tiles', async () => {
    expect(revealedBounds(await decodeShard(view()))).toEqual({ x0: 1, y0: 0, x1: 2, y1: 1 });
    expect(revealedBounds({ width: 2, height: 1, tiles: new Uint8Array(2) })).toBeNull();
  });

  it('fitView centres the bounds and caps the zoom', () => {
    const v = fitView({ x0: 10, y0: 10, x1: 29, y1: 19 }, 300, 300, 0);
    expect(v.scale).toBe(15); // 300 / 20 wide
    expect(10 * v.scale + v.ox).toBeCloseTo(0); // exactly as wide as the viewport
    expect(screenToTile(v, 150, 150)).toEqual({ x: 20, y: 15 }); // the bounds' centre
    expect(fitView({ x0: 0, y0: 0, x1: 0, y1: 0 }, 300, 300).scale).toBe(MAX_SCALE);
  });

  it('centreOn puts the tile centre in the middle; screenToTile inverts', () => {
    const v = centreOn({ tx: 20, ty: 30 }, 10, 400, 300);
    expect(screenToTile(v, 200, 150)).toEqual({ x: 20.5, y: 30.5 });
  });

  it('zoomAt keeps the point under the finger fixed and clamps', () => {
    const v = { scale: 4, ox: 10, oy: 20 };
    const z = zoomAt(v, 2, 100, 100, 1);
    expect(z.scale).toBe(8);
    expect(screenToTile(z, 100, 100)).toEqual(screenToTile(v, 100, 100));
    expect(zoomAt(v, 100, 0, 0, 1).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, 0.001, 0, 0, 2).scale).toBe(2);
  });
});

describe('containersNear / containerText', () => {
  const c = (name: string, tx: number, ty: number, items: MapContainer['items'] = []) => ({
    tx,
    ty,
    prefab: name.toLowerCase(),
    name,
    items,
  });
  it('lists every container near the tap, nearest first', () => {
    const list = [c('Chest', 19, 29), c('Ice Box', 21, 31), c('Chest', 19, 29), c('Far', 30, 30)];
    expect(containersNear(list, 20.5, 30.5).map((x) => x.name)).toEqual([
      'Chest',
      'Chest',
      'Ice Box',
    ]);
    expect(containersNear(list, 0, 0)).toEqual([]);
  });
  it('formats contents', () => {
    expect(containerText(c('Chest', 0, 0, [{ prefab: 'log', name: 'Log', count: 38 }]))).toBe(
      'Chest: Log 38',
    );
    expect(containerText(c('Ice Box', 0, 0))).toBe('Ice Box: empty');
  });
});

describe('mapAsOfText', () => {
  it('day and date, either optional', () => {
    expect(mapAsOfText(60, '2026-09-27T12:00:00.000Z', 'en-US')).toBe('As of day 60 · Sun, Sep 27');
    expect(mapAsOfText(null, 'nope', 'en-US')).toBe('');
    expect(mapAsOfText(3, null)).toBe('As of day 3');
  });
});
