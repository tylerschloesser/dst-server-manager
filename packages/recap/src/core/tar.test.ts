import { describe, expect, it } from 'vitest';

import { makeTar, tarHeader, zstd } from '../test-support/synthetic';
import { SaveFormatError } from './lua';
import { readSaveTarball, readTar } from './tar';

const all = () => true;
const LONG = `Master/save/session/00000000000000AA/${'D'.repeat(90)}/0000000001`;

describe('readTar', () => {
  it('reads plain ustar regular files and normalizes a leading ./', () => {
    const tar = makeTar([
      { path: 'a.txt', data: 'hello' },
      { path: './b/c.txt', data: 'x'.repeat(513) }, // spans two blocks
    ]);
    const out = readTar(tar, all);
    expect(out.map((e) => e.path)).toEqual(['a.txt', 'b/c.txt']);
    expect(out[0]!.data.toString()).toBe('hello');
    expect(out[1]!.data.length).toBe(513);
  });

  it('keeps only what the filter asks for', () => {
    const tar = makeTar([
      { path: 'keep', data: '1' },
      { path: 'drop', data: '2' },
    ]);
    expect(readTar(tar, (p) => p === 'keep').map((e) => e.path)).toEqual(['keep']);
  });

  it('ignores directories, symlinks, hard links and global pax headers', () => {
    const tar = makeTar([
      { path: 'dir/', type: '5' },
      { path: 'link', type: '2' },
      { path: 'hard', type: '1' },
      { path: 'g', type: 'g', data: '11 comment\n' },
      { path: 'dir/file', data: 'f' },
    ]);
    expect(readTar(tar, all).map((e) => e.path)).toEqual(['dir/file']);
  });

  it('applies a pax `x` path to the next entry only', () => {
    const tar = makeTar([
      { path: LONG, data: 'long', longName: 'pax' },
      { path: 'short', data: 's' },
    ]);
    const out = readTar(tar, all);
    expect(out.map((e) => e.path)).toEqual([LONG, 'short']);
    expect(out[0]!.data.toString()).toBe('long');
  });

  it('applies a GNU `L` long name (GNU "ustar  " magic)', () => {
    const tar = makeTar([
      { path: LONG, data: 'gnu', longName: 'gnu' },
      { path: 'next', data: 'n', magic: 'gnu' },
    ]);
    expect(readTar(tar, all).map((e) => e.path)).toEqual([LONG, 'next']);
  });

  it('joins the ustar prefix field with the name', () => {
    const h = tarHeader({ name: 'file', size: 1, type: '0' });
    // the ustar prefix field (offset 345); the reader does not verify the checksum
    h.write('pre/fix', 345, 'utf8');
    const data = Buffer.alloc(512);
    data.write('z');
    const tar = Buffer.concat([h, data, Buffer.alloc(1024)]);
    expect(readTar(tar, all).map((e) => e.path)).toEqual(['pre/fix/file']);
  });

  it('throws on a bad header magic', () => {
    const tar = makeTar([{ path: 'x', data: 'y', magic: 'bad' }]);
    expect(() => readTar(tar, all)).toThrow(SaveFormatError);
    expect(() => readTar(tar, all)).toThrow(/bad header magic/);
  });

  it('throws on a truncated entry', () => {
    const tar = makeTar([{ path: 'x', data: 'y'.repeat(2000) }], { end: false });
    expect(() => readTar(tar.subarray(0, 1024), all)).toThrow(/truncated entry/);
  });

  it('throws without the end-of-archive marker', () => {
    const tar = makeTar([{ path: 'x', data: 'y' }], { end: false });
    expect(() => readTar(tar, all)).toThrow(/missing end-of-archive marker/);
    expect(() => readTar(Buffer.alloc(0), all)).toThrow(/missing end-of-archive marker/);
  });

  it('throws on an unknown entry type', () => {
    const tar = makeTar([{ path: 'fifo', type: '6' }]);
    expect(() => readTar(tar, all)).toThrow(/unsupported entry type "6" for fifo/);
  });

  it('refuses a base-256 size and a non-octal size', () => {
    const h = tarHeader({ name: 'x', size: 0, type: '0' });
    h[124] = 0x80;
    expect(() => readTar(Buffer.concat([h, Buffer.alloc(1024)]), all)).toThrow(/base-256/);
    const h2 = tarHeader({ name: 'x', size: 0, type: '0' });
    h2.write('00000000009\0', 124, 'latin1');
    expect(() => readTar(Buffer.concat([h2, Buffer.alloc(1024)]), all)).toThrow(/bad octal size/);
  });
});

describe('readSaveTarball', () => {
  it('decompresses zstd then reads the tar', () => {
    const out = readSaveTarball(zstd(makeTar([{ path: 'a', data: 'b' }])), all);
    expect(out).toEqual([{ path: 'a', data: Buffer.from('b') }]);
  });

  it('turns zstd garbage into SaveFormatError', () => {
    expect(() => readSaveTarball(Buffer.from('not zstd at all'), all)).toThrow(SaveFormatError);
    expect(() => readSaveTarball(Buffer.from('not zstd at all'), all)).toThrow(/^zstd: /);
  });
});
