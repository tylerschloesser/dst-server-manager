// Reads `save.tar.zst` (docs/storage.md §6) without touching the filesystem: zstd via Node's
// built-in zlib (Node >= 22.15), then a strict ustar reader that understands the three header
// extensions our two tar producers emit — POSIX pax (`x`, bsdtar on macOS, used by the import
// script) and GNU long names (`L`, GNU tar on the instance). Anything else unexpected throws.
import { zstdDecompressSync } from 'node:zlib';

import { SaveFormatError } from './lua';

const BLOCK = 512;

export interface TarEntry {
  path: string; // normalized: no leading './'
  data: Buffer;
}

function readString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function readOctal(buf: Buffer, start: number, len: number, what: string): number {
  const first = buf[start] ?? 0;
  if (first & 0x80) {
    // GNU base-256 for large sizes; save files are far below 8 GiB, so refuse it loudly.
    throw new SaveFormatError(`tar: base-256 ${what} is not supported`);
  }
  const text = readString(buf, start, len).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text))
    throw new SaveFormatError(`tar: bad octal ${what} ${JSON.stringify(text)}`);
  return parseInt(text, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.subarray(pos, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) throw new SaveFormatError('tar: bad pax record length');
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8'); // drop trailing \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

function normalize(path: string): string {
  let p = path;
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Decompresses and walks the archive, keeping only regular files for which `keep(path)` is true
 *  (so a 25 MB uncompressed save never needs to be fully copied). */
export function readSaveTarball(compressed: Buffer, keep: (path: string) => boolean): TarEntry[] {
  let tar: Buffer;
  try {
    tar = zstdDecompressSync(compressed);
  } catch (err) {
    throw new SaveFormatError(`zstd: ${err instanceof Error ? err.message : String(err)}`);
  }
  return readTar(tar, keep);
}

export function readTar(tar: Buffer, keep: (path: string) => boolean): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;
  let pendingPath: string | null = null;
  let sawEnd = false;

  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) {
      sawEnd = true;
      break;
    }
    const magic = readString(header, 257, 6);
    if (magic !== 'ustar' && magic !== 'ustar ') {
      throw new SaveFormatError(`tar: bad header magic at offset ${pos}`);
    }
    const size = readOctal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] ?? 0);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new SaveFormatError('tar: truncated entry');
    const data = tar.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      const pax = parsePax(data);
      if (pax['path'] !== undefined) pendingPath = pax['path'];
      continue;
    }
    if (type === 'g') continue; // global pax header: nothing we use
    if (type === 'L') {
      pendingPath = readString(data, 0, data.length);
      continue;
    }

    const path = normalize(pendingPath ?? (prefix !== '' ? `${prefix}/${name}` : name));
    pendingPath = null;
    if (type === '0' || type === '\0') {
      if (keep(path)) entries.push({ path, data: Buffer.from(data) });
    } else if (type !== '5' && type !== '2' && type !== '1') {
      throw new SaveFormatError(`tar: unsupported entry type ${JSON.stringify(type)} for ${path}`);
    }
  }
  if (!sawEnd) throw new SaveFormatError('tar: missing end-of-archive marker');
  return entries;
}
