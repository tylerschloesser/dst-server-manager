// docs/web.md §3 Map: the map's pure half (colours, decode, paint, view maths, tap hit-testing).
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { MapContainer, MapShardView } from '@dst/shared';

import {
  FOG_RGB,
  FRESH_RGB,
  DEFAULT_HEADING,
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
  project,
  revealedExtent,
  rotateView,
  screenToTile,
  tileColor,
  tileToScreen,
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

const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe('project (the game camera)', () => {
  it('is its own inverse and a reflection at every Q/E heading', () => {
    for (const h of HEADINGS) {
      close(project(h, ...(Object.values(project(h, 3, -7)) as [number, number])), { x: 3, y: -7 });
      const ex = project(h, 1, 0);
      const ez = project(h, 0, 1);
      expect(ex.x * ez.y - ez.x * ex.y).toBeCloseTo(-1, 12);
    }
  });

  it('matches followcamera.lua: down = (cos h, sin h), right = (-sin h, cos h) in world (x, z)', () => {
    // h = 0: +x is straight down, +z straight right.
    close(project(0, 1, 0), { x: 0, y: 1 });
    close(project(0, 0, 1), { x: 1, y: 0 });
    // The default h = 45 (every fresh client): +x goes down-left, +z down-right. Plotting x right
    // and z down, as the map once did, is the mirror image of the in-game map.
    expect(DEFAULT_HEADING).toBe(45);
    const r = Math.SQRT1_2;
    close(project(45, 1, 0), { x: -r, y: r });
    close(project(45, 0, 1), { x: r, y: r });
  });
});

describe('view maths', () => {
  it('revealedExtent is the projected box of non-fog tiles', async () => {
    // Tiles (1,0), (2,0), (1,1): at h = 0 the screen axes are (z, x), so the box is the grid's
    // box transposed.
    expect(revealedExtent(await decodeShard(view()), 0)).toEqual({ x0: 0, y0: 1, x1: 2, y1: 3 });
    expect(revealedExtent({ width: 2, height: 1, tiles: new Uint8Array(2) }, 45)).toBeNull();
  });

  it('revealedExtent of one tile is its diagonal at 45 degrees', () => {
    const one = { width: 1, height: 1, tiles: Uint8Array.of(1) };
    const e = revealedExtent(one, 45)!;
    expect(e.x1 - e.x0).toBeCloseTo(Math.SQRT2);
    expect(e.y1 - e.y0).toBeCloseTo(Math.SQRT2);
    close({ x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 }, project(45, 0.5, 0.5));
  });

  it('revealedExtent of an L is square at 0 and wide and shallow at 45', () => {
    // 3×3 grid, an L along the top row and down the left column.
    const L = { width: 3, height: 3, tiles: Uint8Array.of(1, 1, 1, 1, 0, 0, 1, 0, 0) };
    const e0 = revealedExtent(L, 0)!;
    expect([e0.x1 - e0.x0, e0.y1 - e0.y0]).toEqual([3, 3]);
    const e45 = revealedExtent(L, 45)!;
    // At 45 the arms point down-left and down-right: the end tiles' centres are 2√2 apart across
    // and √2 below the corner's, each plus a tile's diagonal (√2).
    expect(e45.x1 - e45.x0).toBeCloseTo(2 * Math.SQRT2 + Math.SQRT2);
    expect(e45.y1 - e45.y0).toBeCloseTo(Math.SQRT2 + Math.SQRT2);
  });

  it('screenToTile inverts tileToScreen at a turned heading', () => {
    const v = { scale: 7, ox: 30, oy: -40, heading: 45 };
    close(screenToTile(v, ...(Object.values(tileToScreen(v, 12.25, 3.5)) as [number, number])), {
      x: 12.25,
      y: 3.5,
    });
  });

  it('fitView centres the extent and caps the zoom', () => {
    const e = { x0: 10, y0: 10, x1: 30, y1: 20 };
    const v = fitView(e, 300, 300, 45, 0);
    expect(v.scale).toBe(15); // 300 / 20 wide
    expect(v.heading).toBe(45);
    expect(10 * v.scale + v.ox).toBeCloseTo(0); // exactly as wide as the viewport
    // The extent's centre (20, 15) is in projected units; project is its own inverse, so the
    // tile drawn there is project(20, 15).
    close(tileToScreen(v, ...(Object.values(project(45, 20, 15)) as [number, number])), {
      x: 150,
      y: 150,
    });
    expect(fitView({ x0: 0, y0: 0, x1: 1, y1: 1 }, 300, 300, 45).scale).toBe(MAX_SCALE);
  });

  it('centreOn puts the tile centre in the middle at any heading', () => {
    for (const h of HEADINGS) {
      close(screenToTile(centreOn({ tx: 20, ty: 30 }, 10, 400, 300, h), 200, 150), {
        x: 20.5,
        y: 30.5,
      });
    }
  });

  it('rotateView turns by 45 and keeps the tile under the centre fixed', () => {
    const v = centreOn({ tx: 20, ty: 30 }, 10, 400, 300, 45);
    const panned = { ...v, ox: v.ox + 37, oy: v.oy - 11 };
    const under = screenToTile(panned, 200, 150);
    const r = rotateView(panned, 45, 400, 300);
    expect(r.heading).toBe(90);
    expect(r.scale).toBe(10);
    close(screenToTile(r, 200, 150), under);
    expect(rotateView(v, -90, 400, 300).heading).toBe(315); // normalised to [0, 360)
    expect(rotateView({ ...v, heading: 315 }, 45, 400, 300).heading).toBe(0);
  });

  it('zoomAt keeps the point under the finger fixed and clamps', () => {
    const v = { scale: 4, ox: 10, oy: 20, heading: 45 };
    const z = zoomAt(v, 2, 100, 100, 1);
    expect(z.scale).toBe(8);
    expect(z.heading).toBe(45);
    close(screenToTile(z, 100, 100), screenToTile(v, 100, 100));
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
