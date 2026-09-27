import { describe, expect, it } from 'vitest';

import { makeTar, saveTarZst, zstd } from '../test-support/synthetic';
import type { ShardSaveSpec } from '../test-support/synthetic';
import { SaveFormatError } from './lua';
import { loadSaveFiles, pickSaveFiles } from './save';
import type { TarEntry } from './tar';

const meta = (cycles: number) => ({ cycles, season: 'autumn', elapsed: cycles, remaining: 10 });

function shard(sessionId: string, ns: number[], players = true): ShardSaveSpec {
  return {
    sessionId,
    worlds: Object.fromEntries(ns.map((n) => [n, `return {n=${n}}`])),
    metas: Object.fromEntries(ns.map((n) => [n, meta(n)])),
    ...(players
      ? {
          players: {
            TESTUSERDIR1: {
              snapshots: { [ns.at(-1)!]: Buffer.from('p1') },
              savelocation: 0x81,
            },
          },
        }
      : {}),
  };
}

const e = (path: string, data = ''): TarEntry => ({ path, data: Buffer.from(data) });

describe('pickSaveFiles / loadSaveFiles', () => {
  it('picks the newest world snapshot per shard, every meta, and player dirs + savelocation', () => {
    const files = loadSaveFiles(
      saveTarZst({
        master: shard('00000000000000AA', [3, 4, 10]),
        caves: shard('00000000000000BB', [7, 8], false),
      }),
    );
    const m = files.master!;
    expect(m.shard).toBe('master');
    expect(m.sessionId).toBe('00000000000000AA');
    expect(m.newestWorld.n).toBe(10); // numeric, not lexical
    expect(m.newestWorld.data.toString()).toBe('return {n=10}');
    expect([...m.metas.keys()].sort((a, b) => a - b)).toEqual([3, 4, 10]);
    expect(m.metas.get(4)).toContain('cycles=4');
    const p = m.players.get('TESTUSERDIR1')!;
    expect(p.userdir).toBe('TESTUSERDIR1');
    expect([...p.snapshots.keys()]).toEqual([10]);
    expect(p.snapshots.get(10)!.toString()).toBe('p1');
    expect(p.metas.get(10)).toContain('character');
    expect(p.savelocation).toEqual(Buffer.from([0x81]));
    expect(files.caves!.newestWorld.n).toBe(8);
    expect(files.caves!.players.size).toBe(0);
  });

  it('works with a ./ prefix as GNU tar writes it', () => {
    const files = loadSaveFiles(
      saveTarZst({ master: shard('00000000000000AA', [1]), prefix: './' }),
    );
    expect(files.master!.newestWorld.n).toBe(1);
  });

  it('ignores macOS ._ AppleDouble twins', () => {
    const files = pickSaveFiles([
      e('Master/save/session/00000000000000AA/0000000001', 'real'),
      e('Master/save/session/00000000000000AA/._0000000009', 'appledouble'),
      e('Master/save/session/00000000000000AA/TESTUSERDIR1/._0000000009', 'appledouble'),
    ]);
    expect(files.master!.newestWorld.n).toBe(1);
    expect(files.master!.players.size).toBe(0);
  });

  it('ignores files that are not session snapshots', () => {
    const files = pickSaveFiles([
      e('Master/save/shardindex', 'x'),
      e('Master/save/session/00000000000000AA/0000000002', 'w'),
      e('Master/save/session/00000000000000AA/savelocation', 'x'),
      e('Master/save/session/00000000000000aa/0000000009', 'lowercase hex is not a session'),
      e('Master/save/session/00000000000000AA/0000000003.bak', 'x'),
      e('cluster_settings_placeholder.txt', 'x'),
    ]);
    expect(files.master!.newestWorld.n).toBe(2);
    expect(files.caves).toBeUndefined();
  });

  it('a world without caves yields only master', () => {
    const files = loadSaveFiles(saveTarZst({ master: shard('00000000000000AA', [1]) }));
    expect(Object.keys(files)).toEqual(['master']);
  });

  it('with two session dirs on a shard, takes the one holding the newest snapshot', () => {
    for (const order of [0, 1]) {
      const dirs = [shard('00000000000000A1', [4, 5]), shard('00000000000000A2', [20, 21])];
      if (order) dirs.reverse();
      const files = loadSaveFiles(
        saveTarZst({ master: dirs[0]!, extra: [{ shard: 'master', spec: dirs[1]! }] }),
      );
      expect(files.master!.sessionId).toBe('00000000000000A2');
      expect(files.master!.newestWorld.n).toBe(21);
    }
  });

  it('a session dir with player files but no world snapshot is not a world', () => {
    const files = pickSaveFiles([
      e('Master/save/session/00000000000000A1/TESTUSERDIR1/0000000099', 'p'),
      e('Master/save/session/00000000000000A2/0000000003', 'w'),
    ]);
    expect(files.master!.sessionId).toBe('00000000000000A2');
  });

  it('refuses two session dirs with equally new snapshots', () => {
    expect(() =>
      loadSaveFiles(
        saveTarZst({
          master: shard('00000000000000A1', [7]),
          extra: [{ shard: 'master', spec: shard('00000000000000A2', [7]) }],
        }),
      ),
    ).toThrow(/two session directories with snapshot 7/);
  });

  it('refuses a save with no Master world snapshot', () => {
    expect(() => loadSaveFiles(saveTarZst({ caves: shard('00000000000000BB', [1]) }))).toThrow(
      SaveFormatError,
    );
    expect(() => loadSaveFiles(zstd(makeTar([{ path: 'readme', data: 'x' }])))).toThrow(
      /no Master world snapshot/,
    );
  });
});
