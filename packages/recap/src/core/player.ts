// The per-player file (docs/research/save-anatomy.md §3):
//
//   3 bytes (not decoded, not needed)
//   "return {…}"                       Lua, the player's save record
//   0x01                               version byte
//   per shard map:
//     u16 BE id length (16) | 16 B shard session id (ASCII hex) | u32 BE block length
//     u32 LE 1 | u32 LE 16 | u32 LE raw length | u32 LE compressed length | zlib stream
//
// The inflated payload ends with the *visited* bitmap: ceil(w*h/8) bytes, 1 bit per tile,
// MSB-first, row-major. Everything before it (the seeable/fog prefix) is not decoded.
// TODO(map): the exact fog of war — docs/follow-ups.md §14 (the map uses the dilated trail meanwhile).
import { inflateSync } from 'node:zlib';

import { SaveFormatError } from './lua';

export interface PlayerMapBlock {
  shardSessionId: string;
  payload: Buffer; // inflated
}

export interface SplitPlayerFile {
  lua: string;
  maps: PlayerMapBlock[];
}

const HEX16 = /^[0-9A-F]{16}$/;

export function splitPlayerFile(buf: Buffer, what: string): SplitPlayerFile {
  const start = buf.indexOf('return {');
  if (start === -1 || start > 16)
    throw new SaveFormatError(`${what}: no "return {" near the start`);

  // The Lua ends right before the 0x01 version byte, which is followed either by the first map
  // header (u16 BE 16 + 16 hex chars) or by the end of the file (a player with no maps).
  let luaEnd = -1;
  let search = start;
  for (;;) {
    const i = buf.indexOf(0x01, search);
    if (i === -1) break;
    const atEnd = i === buf.length - 1;
    const header =
      i + 19 <= buf.length &&
      buf.readUInt16BE(i + 1) === 16 &&
      HEX16.test(buf.subarray(i + 3, i + 19).toString('latin1'));
    if ((atEnd || header) && buf[i - 1] === 0x7d /* } */) {
      luaEnd = i;
      break;
    }
    search = i + 1;
  }
  if (luaEnd === -1) throw new SaveFormatError(`${what}: cannot find the end of the Lua record`);

  const lua = buf.subarray(start, luaEnd).toString('utf8');
  const maps: PlayerMapBlock[] = [];
  let pos = luaEnd + 1;
  while (pos < buf.length) {
    if (pos + 2 > buf.length) throw new SaveFormatError(`${what}: truncated map header`);
    const idLen = buf.readUInt16BE(pos);
    if (idLen !== 16) throw new SaveFormatError(`${what}: map id length ${idLen}, expected 16`);
    const shardSessionId = buf.subarray(pos + 2, pos + 18).toString('latin1');
    if (!HEX16.test(shardSessionId)) throw new SaveFormatError(`${what}: bad shard session id`);
    const blockLen = buf.readUInt32BE(pos + 18);
    const block = buf.subarray(pos + 22, pos + 22 + blockLen);
    if (block.length !== blockLen || blockLen < 16)
      throw new SaveFormatError(`${what}: truncated map block`);
    const one = block.readUInt32LE(0);
    const headerSize = block.readUInt32LE(4);
    const rawLen = block.readUInt32LE(8);
    const compLen = block.readUInt32LE(12);
    if (one !== 1 || headerSize !== 16 || compLen !== blockLen - 16) {
      throw new SaveFormatError(
        `${what}: unexpected map block header (${one}, ${headerSize}, ${compLen}/${blockLen})`,
      );
    }
    let payload: Buffer;
    try {
      payload = inflateSync(block.subarray(16));
    } catch (err) {
      throw new SaveFormatError(
        `${what}: map zlib: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (payload.length !== rawLen) {
      throw new SaveFormatError(
        `${what}: map inflated to ${payload.length} bytes, header says ${rawLen}`,
      );
    }
    maps.push({ shardSessionId, payload });
    pos += 22 + blockLen;
  }
  return { lua, maps };
}

export function bitmapBytes(width: number, height: number): number {
  return Math.ceil((width * height) / 8);
}

/** The visited bitmap: the last ceil(w*h/8) bytes of the payload (22,579 for 425×425). */
export function visitedBitmap(
  payload: Buffer,
  width: number,
  height: number,
  what: string,
): Buffer {
  const n = bitmapBytes(width, height);
  if (payload.length < n) throw new SaveFormatError(`${what}: map payload shorter than the bitmap`);
  return payload.subarray(payload.length - n);
}

export function popcount(bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) {
    let b = bits[i]!;
    while (b !== 0) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

/** after AND NOT before (bytes, MSB-first like the source). `before` may be null (first visit). */
export function newBits(after: Uint8Array, before: Uint8Array | null): Buffer {
  const out = Buffer.alloc(after.length);
  for (let i = 0; i < after.length; i++) out[i] = after[i]! & ~(before?.[i] ?? 0);
  return out;
}

export function isBitSet(bits: Uint8Array, width: number, tx: number, ty: number): boolean {
  const i = ty * width + tx;
  return ((bits[i >> 3]! >> (7 - (i & 7))) & 1) === 1;
}
