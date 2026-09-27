import { describe, expect, it } from 'vitest';

import { item, nodeIdList, vrsnGrid, worldLua } from '../test-support/synthetic';
import type { WorldSpec } from '../test-support/synthetic';
import { SaveFormatError, evalLuaTable } from './lua';
import {
  biomeAt,
  biomeName,
  decodeVrsnGrid,
  luaSlots,
  stackOf,
  summarizeWorld,
  tileOf,
} from './world';
import type { WorldMap } from './world';

const TOPOLOGY = ['Dig that rock:7:Rocky', 'X:BG_1:BGGrass', 'Y:3:DeepForest'];

function spec(ents: WorldSpec['ents']): WorldSpec {
  return {
    width: 4,
    height: 3,
    // row 0: ocean; row 1: Rocky Rocky Grass Grass; row 2: Deep Forest
    nodeIds: (tx, ty) => (ty === 0 ? 0 : ty === 2 ? 3 : tx < 2 ? 1 : 2),
    topology: TOPOLOGY,
    ents,
  };
}

const placeable = (p: string) => ['treasurechest', 'icebox', 'campfire'].includes(p);

describe('luaSlots / stackOf', () => {
  it('returns [slot, value] in slot order for arrays and sparse objects', () => {
    expect(luaSlots(['a', 'b'])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(luaSlots({ '10': 'c', '6': 'b', '1': 'a', name: 'ignored' })).toEqual([
      [1, 'a'],
      [6, 'b'],
      [10, 'c'],
    ]);
    expect(luaSlots(null)).toEqual([]);
    expect(luaSlots('x')).toEqual([]);
  });

  it('stackOf reads data.stackable.stack, defaulting to 1', () => {
    expect(stackOf({ prefab: 'log', data: { stackable: { stack: 20 } } })).toBe(20);
    expect(stackOf({ prefab: 'axe' })).toBe(1);
    expect(stackOf({ prefab: 'x', data: { stackable: { stack: 0 } } })).toBe(1);
    expect(stackOf('x')).toBe(1);
  });
});

describe('summarizeWorld', () => {
  it('counts entities, totals stacks in containers, groups containers and filters placed', async () => {
    const world = await evalLuaTable(
      worldLua(
        spec({
          treasurechest: [
            { x: 1, z: 2, items: [item('log', { stack: 20 }), item('rocks', { stack: 3 })] },
            {
              x: -4,
              z: 0,
              items: new Map([
                [2, item('log', { stack: 5 })],
                [9, item('axe')],
              ]),
            },
          ],
          icebox: [{ x: 0, z: 0, items: [] }],
          rabbit: [{ x: 3, z: 3 }, { x: 4, z: 4 }, {}],
          terrariumchest: [{ x: 8, z: 8, items: [item('goldnugget', { stack: 2 })] }],
          campfire: [{}], // a placeable without a position is counted but not placed
        }),
      ),
    );
    const s = summarizeWorld(world, placeable);
    expect(Object.fromEntries(s.counts)).toEqual({
      treasurechest: 2,
      icebox: 1,
      rabbit: 3,
      terrariumchest: 1,
      campfire: 1,
    });
    expect(Object.fromEntries(s.stored)).toEqual({ log: 25, rocks: 3, axe: 1, goldnugget: 2 });
    expect(s.placed).toEqual(
      expect.arrayContaining([
        { prefab: 'treasurechest', x: 1, z: 2 },
        { prefab: 'treasurechest', x: -4, z: 0 },
        { prefab: 'icebox', x: 0, z: 0 },
      ]),
    );
    expect(s.placed).toHaveLength(3); // no rabbits, no terrarium, no position-less campfire
    const chests = s.containerGroups.get('treasurechest')!;
    expect(chests.containers).toBe(2);
    expect(Object.fromEntries(chests.items)).toEqual({ log: 25, rocks: 3, axe: 1 });
    expect(s.containerGroups.get('icebox')!.containers).toBe(1);
    expect(s.containerGroups.get('icebox')!.items.size).toBe(0);
    expect(s.containerGroups.has('terrariumchest')).toBe(true); // filtered later, by the digest
    expect(s.map.width).toBe(4);
    expect(s.map.topologyIds).toEqual(TOPOLOGY);
    expect([...s.map.nodeIds]).toEqual(nodeIdList(spec({})));
  });

  it('refuses a world without map/ents, bad dimensions, or no topology', () => {
    expect(() => summarizeWorld({}, placeable)).toThrow(/missing map or ents/);
    expect(() => summarizeWorld({ map: { width: 0, height: 1 }, ents: {} }, placeable)).toThrow(
      /bad map width\/height/,
    );
    expect(() => summarizeWorld({ map: { width: 1, height: 1 }, ents: {} }, placeable)).toThrow(
      /missing nodeidtilemap or topology.ids/,
    );
    expect(() =>
      summarizeWorld(
        {
          map: { width: 2, height: 2, nodeidtilemap: vrsnGrid([0, 0, 0]), topology: { ids: [] } },
          ents: {},
        },
        placeable,
      ),
    ).toThrow(SaveFormatError);
  });
});

describe('decodeVrsnGrid', () => {
  it('decodes u16 LE node ids after the 9-byte header', () => {
    expect([...decodeVrsnGrid(vrsnGrid([0, 1, 258, 65535]), 2, 2, 'g')]).toEqual([
      0, 1, 258, 65535,
    ]);
  });

  it('refuses a bad header, a version other than 1, and a wrong length', () => {
    expect(() => decodeVrsnGrid(vrsnGrid([0], { magic: 'NOPE' }), 1, 1, 'g')).toThrow(
      /missing VRSN header/,
    );
    const noNul = Buffer.from(vrsnGrid([0]), 'base64');
    noNul[4] = 1;
    expect(() => decodeVrsnGrid(noNul.toString('base64'), 1, 1, 'g')).toThrow(/missing VRSN/);
    expect(() => decodeVrsnGrid(vrsnGrid([0], { version: 2 }), 1, 1, 'g')).toThrow(
      /VRSN version 2, expected 1/,
    );
    expect(() => decodeVrsnGrid(vrsnGrid([0, 0, 0]), 2, 2, 'g')).toThrow(
      /15 bytes, expected 17 for 2x2/,
    );
  });
});

describe('biomes', () => {
  it('biomeName takes the last topology segment, drops BG, and splits camel case', () => {
    expect(biomeName('Dig that rock:7:Rocky')).toBe('Rocky');
    expect(biomeName('X:BG_1:BGGrass')).toBe('Grass');
    expect(biomeName('For a nice walk:BG_64:BGForest')).toBe('Forest');
    expect(biomeName('DeepForest')).toBe('Deep Forest');
    expect(biomeName('Some:1:Mud_Lake')).toBe('Mud Lake');
    expect(biomeName('')).toBeNull();
    expect(biomeName('X:1:BG')).toBeNull();
  });

  it('tileOf maps world units (TILE_SCALE 4) to a tile, centred, null off-map', () => {
    const map: WorldMap = {
      width: 4,
      height: 3,
      nodeIds: new Uint16Array(12),
      topologyIds: [],
    };
    expect(tileOf(map, 0, 0)).toEqual({ tx: 2, ty: 1 });
    expect(tileOf(map, -8, -6)).toEqual({ tx: 0, ty: 0 });
    expect(tileOf(map, 7.9, 5.9)).toEqual({ tx: 3, ty: 2 });
    expect(tileOf(map, 8, 0)).toBeNull();
    expect(tileOf(map, 0, -6.1)).toBeNull();
  });

  it('biomeAt: node ids are 1-based into topology.ids and 0 means no area', () => {
    const nodeIds = Uint16Array.from(nodeIdList(spec({})));
    const map: WorldMap = { width: 4, height: 3, nodeIds, topologyIds: TOPOLOGY };
    // row 0 (z in [-6,-2)) is ocean
    expect(biomeAt(map, 0, -5)).toBeNull();
    // row 1: tx 0-1 -> node 1 (ids[0] Rocky), tx 2-3 -> node 2 (ids[1] Grass)
    expect(biomeAt(map, -7, 0)).toBe('Rocky');
    expect(biomeAt(map, 1, 0)).toBe('Grass');
    // row 2 -> node 3 (ids[2])
    expect(biomeAt(map, 0, 3)).toBe('Deep Forest');
    // off the map
    expect(biomeAt(map, 100, 0)).toBeNull();
    // a node id past the end of topology.ids
    const bad: WorldMap = { ...map, nodeIds: Uint16Array.from(new Array(12).fill(9)) };
    expect(biomeAt(bad, 0, 0)).toBeNull();
  });
});
