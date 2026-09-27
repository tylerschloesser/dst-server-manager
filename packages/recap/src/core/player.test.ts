import { describe, expect, it } from 'vitest';

import { bitmap, mapBlock, playerFile, playerLua } from '../test-support/synthetic';
import { evalLuaTable, SaveFormatError } from './lua';
import { bitmapBytes, isBitSet, newBits, popcount, splitPlayerFile, visitedBitmap } from './player';

const SID_A = '00000000000000AA';
const SID_B = '00000000000000BB';

describe('splitPlayerFile', () => {
  it('splits a player with no map blocks (0x01 is the last byte)', async () => {
    const buf = playerFile({ x: 1.5, z: -2, prefab: 'wilson' });
    const split = splitPlayerFile(buf, 'p');
    expect(split.maps).toEqual([]);
    expect(split.lua).toBe(playerLua({ x: 1.5, z: -2, prefab: 'wilson' }));
    const rec = (await evalLuaTable(split.lua)) as Record<string, unknown>;
    expect(rec).toMatchObject({ x: 1.5, z: -2, prefab: 'wilson' });
  });

  it('splits one and two map blocks, in file order, inflating each payload', () => {
    const bmA = bitmap(8, 8, [[0, 0]]);
    const bmB = bitmap(5, 5, [[4, 4]]);
    const one = splitPlayerFile(
      playerFile({ maps: [{ shardSessionId: SID_A, bitmap: bmA }] }),
      'p',
    );
    expect(one.maps.map((m) => m.shardSessionId)).toEqual([SID_A]);
    expect(one.maps[0]!.payload.subarray(-8)).toEqual(bmA);

    const prefix = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    const two = splitPlayerFile(
      playerFile({
        maps: [
          { shardSessionId: SID_B, bitmap: bmB, prefix },
          { shardSessionId: SID_A, bitmap: bmA },
        ],
      }),
      'p',
    );
    expect(two.maps.map((m) => m.shardSessionId)).toEqual([SID_B, SID_A]);
    expect(two.maps[0]!.payload).toEqual(Buffer.concat([prefix, bmB]));
  });

  it('is not fooled by 0x01 bytes inside the map section or the Lua', () => {
    // A bitmap full of 0x01 bytes and a Lua string holding "\1" (escaped, as DST writes it).
    const bm = Buffer.alloc(8, 0x01);
    const buf = playerFile({
      recipes: ['a\x01b'],
      maps: [{ shardSessionId: SID_A, bitmap: bm }],
    });
    const split = splitPlayerFile(buf, 'p');
    expect(split.maps).toHaveLength(1);
    expect(split.maps[0]!.payload.subarray(-8)).toEqual(bm);
  });

  it('refuses a file with no "return {" near the start', () => {
    expect(() => splitPlayerFile(Buffer.from('garbage'), 'p')).toThrow(/no "return \{"/);
    const late = Buffer.concat([Buffer.alloc(40, 0x20), Buffer.from('return {}\x01')]);
    expect(() => splitPlayerFile(late, 'p')).toThrow(/no "return \{"/);
  });

  it('refuses a file whose Lua never ends at a 0x01 + map header', () => {
    const buf = Buffer.concat([Buffer.from('abcreturn {x=1}'), Buffer.from([0x01, 0x00, 0x0f])]);
    expect(() => splitPlayerFile(buf, 'p')).toThrow(/cannot find the end of the Lua record/);
  });

  it('refuses a second map block with a bad id length or a bad shard session id', () => {
    const good = { shardSessionId: SID_A, bitmap: bitmap(8, 8, []) };
    const withSecond = (b: Buffer) => Buffer.concat([playerFile({ maps: [good] }), b]);
    expect(() => splitPlayerFile(withSecond(mapBlock({ ...good, idLen: 15 })), 'p')).toThrow(
      /map id length 15, expected 16/,
    );
    expect(() =>
      splitPlayerFile(withSecond(mapBlock({ ...good, shardSessionId: 'zzzzzzzzzzzzzzzz' })), 'p'),
    ).toThrow(/bad shard session id/);
    expect(() => splitPlayerFile(withSecond(Buffer.from([0x00])), 'p')).toThrow(
      /truncated map header/,
    );
  });

  it('refuses a truncated block, a bad block header, bad zlib and a wrong raw length', () => {
    const good = { shardSessionId: SID_A, bitmap: bitmap(8, 8, [[1, 1]]) };
    const full = playerFile({ maps: [good] });
    expect(() => splitPlayerFile(full.subarray(0, full.length - 3), 'p')).toThrow(
      /truncated map block/,
    );
    expect(() => splitPlayerFile(playerFile({ maps: [{ ...good, one: 2 }] }), 'p')).toThrow(
      /unexpected map block header/,
    );
    expect(() => splitPlayerFile(playerFile({ maps: [{ ...good, badZlib: true }] }), 'p')).toThrow(
      /map zlib/,
    );
    expect(() => splitPlayerFile(playerFile({ maps: [{ ...good, rawLen: 3 }] }), 'p')).toThrow(
      /inflated to 15 bytes, header says 3/,
    );
    try {
      splitPlayerFile(playerFile({ maps: [{ ...good, rawLen: 3 }] }), 'who');
    } catch (err) {
      expect(err).toBeInstanceOf(SaveFormatError);
      expect((err as Error).message).toMatch(/^who: /);
    }
  });
});

describe('bitmaps', () => {
  it('bitmapBytes is ceil(w*h/8)', () => {
    expect(bitmapBytes(425, 425)).toBe(22579);
    expect(bitmapBytes(8, 8)).toBe(8);
    expect(bitmapBytes(5, 5)).toBe(4); // 25 bits -> 4 bytes, not 3
    expect(bitmapBytes(1, 1)).toBe(1);
  });

  it('visitedBitmap takes the LAST ceil(w*h/8) bytes of the payload', () => {
    const payload = Buffer.from([0xaa, 0xbb, 0xcc, 1, 2, 3, 4]);
    expect(visitedBitmap(payload, 5, 5, 'p')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(visitedBitmap(payload, 8, 7, 'p')).toEqual(payload);
    expect(() => visitedBitmap(payload, 8, 8, 'p')).toThrow(/shorter than the bitmap/);
  });

  it('is MSB-first and row-major (proved on a 5x5 grid whose size is not a multiple of 8)', () => {
    const bm = bitmap(5, 5, [
      [0, 0],
      [4, 4],
    ]);
    // tile 0 -> byte 0 bit 7; tile 24 -> byte 3 bit 7
    expect(bm).toEqual(Buffer.from([0x80, 0x00, 0x00, 0x80]));
    expect(isBitSet(bm, 5, 0, 0)).toBe(true);
    expect(isBitSet(bm, 5, 4, 4)).toBe(true);
    expect(isBitSet(bm, 5, 1, 0)).toBe(false);
    expect(isBitSet(bm, 5, 0, 1)).toBe(false);
    // (2,1) is tile 7: byte 0 bit 0 (the LSB)
    expect(isBitSet(Buffer.from([0x01, 0, 0, 0]), 5, 2, 1)).toBe(true);
    expect(isBitSet(Buffer.from([0x01, 0, 0, 0]), 5, 0, 0)).toBe(false);
  });

  it('popcount counts set bits', () => {
    expect(popcount(Buffer.from([]))).toBe(0);
    expect(popcount(Buffer.from([0xff, 0x01, 0x80, 0x00]))).toBe(10);
  });

  it('newBits is after AND NOT before; a null before means everything is new', () => {
    const after = Buffer.from([0b1111_0000, 0b0000_0011]);
    const before = Buffer.from([0b1010_0000, 0b0000_0001]);
    expect(newBits(after, before)).toEqual(Buffer.from([0b0101_0000, 0b0000_0010]));
    expect(newBits(after, null)).toEqual(after);
    // a shorter before (defensive) treats the missing bytes as unvisited
    expect(newBits(after, Buffer.from([0xff]))).toEqual(Buffer.from([0x00, 0b0000_0011]));
  });
});
