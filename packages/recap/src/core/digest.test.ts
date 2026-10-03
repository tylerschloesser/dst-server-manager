import { describe, expect, it } from 'vitest';

import { gunzipSync } from 'node:zlib';

import type { Recap, RecapMapIndex, RecapPlayer } from '@dst/shared';

import {
  DAN_KNOWN,
  DIR,
  KU,
  MANIFEST,
  STEAM,
  TILES,
  afterSaveSpec,
  beforeSaveSpec,
  scenarioInput,
  scenarioLogs,
} from '../test-support/scenario';
import { bitmap, item, logText, saveTarZst } from '../test-support/synthetic';
import type { PlayerSpec, WorldSpec } from '../test-support/synthetic';
import {
  DIGEST_VERSION,
  baseCentre,
  carryingOf,
  digestSession,
  itemCondition,
  toItem,
} from './digest';
import { SaveFormatError } from './lua';

const NO_LOGS = { masterChat: null, cavesChat: null, masterServer: null, cavesServer: null };

function player(recap: Recap, persona: string | null, ref?: string): RecapPlayer {
  const p = recap.players.find((x) => (ref !== undefined ? x.ref === ref : x.persona === persona));
  if (p === undefined) throw new Error(`no player ${persona ?? ref}`);
  return p;
}

describe('digestSession: the full synthetic session', async () => {
  const out = await digestSession(scenarioInput());
  const { recap } = out;

  it('stamps versions, ids, session facts and the note', () => {
    expect(recap.schemaVersion).toBe(1);
    expect(recap.digestVersion).toBe(DIGEST_VERSION);
    expect(recap.worldId).toBe('test-recap'); // a test- world digests like any other
    expect(recap.sessionId).toBe(MANIFEST.sessionId);
    expect(recap.generatedAt).toBe('2026-01-01T01:05:00.000Z');
    expect(recap.status).toBe('ok');
    expect(recap.hasCaves).toBe(true);
    expect(recap.continuous).toBe(true);
    expect(recap.session).toEqual({
      startedAt: '2026-01-01T00:00:00.000Z',
      joinableAt: '2026-01-01T00:02:30.000Z',
      stoppedAt: '2026-01-01T01:02:30.000Z',
      stopReason: 'idle',
      realMinutes: 60, // from joinableAt, not startedAt
      peakPlayers: 2,
      startedBy: 'alice-nick',
      dstBuildId: '000000',
    });
    expect(recap.noteAtDigest).toBe('finish the farm');
  });

  it('reads the calendar and the season change', () => {
    expect(recap.time).toEqual({
      start: { day: 5, season: 'spring', dayOfSeason: 5, daysLeftInSeason: 15 },
      end: { day: 9, season: 'summer', dayOfSeason: 2, daysLeftInSeason: 13 },
      daysPassed: 4,
      seasonChanges: [{ season: 'summer', day: 8 }],
    });
  });

  it('built/destroyed count placeable structures only (rabbits 5 -> 9 are ignored)', () => {
    expect(recap.built).toEqual([
      { prefab: 'firepit', name: 'Fire Pit', delta: 2 },
      { prefab: 'treasurechest', name: 'Chest', delta: 1 },
      { prefab: 'icebox', name: 'Ice Box', delta: 1 },
      { prefab: 'researchlab', name: 'Science Machine', delta: 1 },
    ]);
    expect(recap.destroyed).toEqual([{ prefab: 'birdcage', name: 'Birdcage', delta: 1 }]);
    expect(JSON.stringify(recap.built)).not.toContain('rabbit');
  });

  it('storage deltas are sorted by magnitude, gains and losses together', () => {
    expect(recap.storage.map((s) => [s.prefab, s.delta])).toEqual([
      ['log', 15],
      ['twigs', -7],
      ['rocks', 5],
      ['berries', 3],
      ['meat', 2],
    ]);
  });

  it('lists container contents only for player-built storage and followers, per shard', () => {
    expect(recap.containers.map((c) => [c.shard, c.prefab, c.containers])).toEqual([
      ['caves', 'treasurechest', 1],
      ['master', 'treasurechest', 2],
      ['master', 'chester', 1],
      ['master', 'icebox', 1],
    ]);
    expect(recap.containers[1]!.items).toEqual([
      { prefab: 'log', name: 'Log', delta: 25 },
      { prefab: 'rocks', name: 'Rocks', delta: 5 },
    ]);
    // the world-generated terrarium chest and its loot are never revealed
    const json = JSON.stringify(recap.containers);
    expect(json).not.toContain('terrariumchest');
    expect(json).not.toContain('goldnugget');
  });

  it('orders players by persona and excludes a saved player who did not play', () => {
    expect(recap.players.map((p) => [p.ref, p.persona])).toEqual([
      ['p1', 'alice'],
      ['p2', 'bob'],
      ['p3', 'dan'],
    ]);
  });

  it('alice: learned recipes, tiles, dawn positions, last position, stats', () => {
    const a = player(recap, 'alice');
    expect(a.character).toBe('wilson');
    expect(a.characterName).toBe('Wilson P. Higgsbury');
    expect(a.presentBefore).toBe(true);
    expect(a.presentAfter).toBe(true);
    expect(a.learned).toEqual([
      { prefab: 'icebox', name: 'Ice Box' },
      { prefab: 'treasurechest', name: 'Chest' },
    ]);
    expect(a.newTiles).toEqual({ master: 5, caves: null });
    expect(a.totalTiles).toEqual({ master: 15, caves: null });
    // snapshot 12 predates the before save's newest and is excluded; 17 is a same-day save
    expect(a.dailyPositions).toEqual([
      { day: 6, shard: 'master', biome: 'Rocky', atBase: true },
      { day: 7, shard: 'master', biome: 'Grass', atBase: false },
      { day: 8, shard: 'master', biome: 'Deep Forest', atBase: false },
      { day: 9, shard: 'master', biome: 'Rocky', atBase: true },
    ]);
    expect(a.lastPosition).toEqual({
      day: 9,
      shard: 'master',
      biome: 'Deep Forest',
      atBase: false,
    });
    expect(a.stats).toEqual({ health: 100, hunger: 50, sanity: 80 });
    expect(a.deaths).toBe(1);
    expect(a.revives).toBe(1);
    expect(a.caveTrips).toBe(0);
  });

  it('alice: carrying — slot order, equipped slots, backpack contents, conditions', () => {
    expect(player(recap, 'alice').carrying).toEqual({
      inventory: [
        { prefab: 'log', name: 'Log', count: 20 },
        { prefab: 'axe', name: 'Axe', count: 1, condition: { usesLeft: 80 } },
        { prefab: 'meat', name: 'Meat', count: 1, condition: { perishDaysLeft: 2.5 } },
        { prefab: 'berries', name: 'Berries', count: 4, condition: { perishDaysLeft: 0.2 } },
      ],
      equipped: [
        { slot: 'body', item: { prefab: 'backpack', name: 'Backpack', count: 1 } },
        {
          slot: 'hands',
          item: { prefab: 'spear', name: 'Spear', count: 1, condition: { usesLeft: 75.6 } },
        },
        {
          slot: 'head',
          item: {
            prefab: 'footballhat',
            name: 'Football Helmet',
            count: 1,
            condition: { armor: 315 },
          },
        },
      ],
      backpack: {
        prefab: 'backpack',
        name: 'Backpack',
        items: [
          { prefab: 'torch', name: 'Torch', count: 1, condition: { fuel: 45 } },
          { prefab: 'cutgrass', name: 'Cut Grass', count: 10 },
        ],
      },
      shard: 'master',
    });
  });

  it('bob: in the caves at the stop (logs), cave tiles, a cave trip, two deaths', () => {
    const b = player(recap, 'bob');
    expect(b.learned).toEqual([{ prefab: 'spear', name: 'Spear' }]);
    expect(b.newTiles).toEqual({ master: 0, caves: 4 });
    expect(b.totalTiles).toEqual({ master: 3, caves: 4 });
    expect(b.dailyPositions).toEqual([
      { day: 6, shard: 'master', biome: 'Grass', atBase: false },
      { day: 7, shard: 'master', biome: 'Grass', atBase: false },
      { day: 9, shard: 'caves', biome: 'Sinkhole', atBase: false },
    ]);
    expect(b.lastPosition).toEqual({ day: 9, shard: 'caves', biome: 'Sinkhole', atBase: false });
    expect(b.carrying?.shard).toBe('caves');
    expect(b.caveTrips).toBe(1); // the Caves log's own line is not a second trip
    expect(b.deaths).toBe(2);
    expect(b.revives).toBe(1);
  });

  it('dan: first session in this world — no learned flood, identified via knownPlayers', () => {
    const d = player(recap, 'dan');
    expect(d.presentBefore).toBe(false);
    expect(d.presentAfter).toBe(true);
    expect(d.learned).toEqual([]);
    expect(d.newTiles).toEqual({ master: 2, caves: null });
    expect(d.lastPosition).toEqual({ day: 9, shard: 'master', biome: null, atBase: false });
    expect(recap.notes).toContain(
      'p3 has no save before this session (first session in this world)',
    );
    expect(out.players.players[2]).toEqual({
      ref: 'p3',
      ku: KU.dan,
      steamId64: STEAM.dan,
      persona: 'dan',
      userdir: DIR.dan,
    });
  });

  it('deaths: cause, minute, revivedBy and revivedAfterMinutes (a revive after a later death does not count)', () => {
    expect(recap.deaths).toEqual([
      {
        player: 'p1',
        persona: 'alice',
        cause: 'Hound',
        minute: 10,
        revivedBy: 'bob',
        revivedAfterMinutes: 3,
      },
      {
        player: 'p2',
        persona: 'bob',
        cause: 'Darkness',
        minute: 30,
        revivedBy: null,
        revivedAfterMinutes: null,
      },
      {
        player: 'p2',
        persona: 'bob',
        cause: 'Cave Spider',
        minute: 40,
        revivedBy: null,
        revivedAfterMinutes: 5,
      },
    ]);
  });

  it('players.json carries ku/steamId64/persona/userdir; recap.json carries none of them', () => {
    expect(out.players).toEqual({
      schemaVersion: 1,
      players: [
        { ref: 'p1', ku: KU.alice, steamId64: STEAM.alice, persona: 'alice', userdir: DIR.alice },
        { ref: 'p2', ku: KU.bob, steamId64: STEAM.bob, persona: 'bob', userdir: DIR.bob },
        { ref: 'p3', ku: KU.dan, steamId64: STEAM.dan, persona: 'dan', userdir: DIR.dan },
      ],
    });
    const json = JSON.stringify(recap);
    for (const secret of ['KU_', '7656119', 'TESTUSERDIR', ...Object.values(STEAM)]) {
      expect(json).not.toContain(secret);
    }
    for (const f of out.files) {
      const text = f.body.toString('latin1');
      expect(text).not.toContain('KU_');
      expect(text).not.toContain('TESTUSERDIR');
    }
  });

  it('writes per-player trail bitmaps (visited + new) and an index with the dimensions', () => {
    const trail = out.files.filter((f) => f.path.startsWith('trail/'));
    expect(trail.map((f) => f.path)).toEqual([
      'trail/p1/master.visited.bin',
      'trail/p1/master.new.bin',
      'trail/p2/master.visited.bin',
      'trail/p2/master.new.bin',
      'trail/p2/caves.visited.bin',
      'trail/p2/caves.new.bin',
      'trail/p3/master.visited.bin',
      'trail/p3/master.new.bin',
      'trail/index.json',
    ]);
    const body = (p: string) => out.files.find((f) => f.path === p)!.body;
    expect(body('trail/p1/master.new.bin')).toEqual(bitmap(32, 32, TILES.aliceNew));
    expect(body('trail/p1/master.visited.bin')).toEqual(
      bitmap(32, 32, [...TILES.aliceBefore, ...TILES.aliceNew]),
    );
    expect(body('trail/p2/master.new.bin')).toEqual(Buffer.alloc(128));
    expect(body('trail/p2/caves.new.bin')).toEqual(bitmap(8, 8, TILES.bobCaves));
    expect(JSON.parse(body('trail/index.json').toString())).toMatchObject({
      dims: { master: { width: 32, height: 32 }, caves: { width: 8, height: 8 } },
    });
    for (const f of trail)
      expect(f.contentType).toBe(
        f.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      );
  });

  it('writes the map: a palette grid per shard and an index of own storage, base and stops', () => {
    const map = out.files.filter((f) => f.path.startsWith('map/'));
    expect(map.map((f) => [f.path, f.contentType])).toEqual([
      ['map/master.tiles.gz', 'application/gzip'],
      ['map/caves.tiles.gz', 'application/gzip'],
      ['map/index.json', 'application/json'],
    ]);
    const body = (p: string) => map.find((f) => f.path === p)!.body;
    expect(gunzipSync(body('map/master.tiles.gz'))).toEqual(Buffer.alloc(32 * 32, 1));
    expect(gunzipSync(body('map/caves.tiles.gz'))).toEqual(Buffer.alloc(8 * 8, 1));

    const index = JSON.parse(body('map/index.json').toString()) as RecapMapIndex;
    expect(index.schemaVersion).toBe(1);
    expect(index.day).toBe(9);
    expect(index.stoppedAt).toBe(MANIFEST.stoppedAt);
    const master = index.shards.master!;
    expect(master).toMatchObject({ width: 32, height: 32, palette: ['GRASS'] });
    // The players' own storage only: the world-gen terrariumchest at (50, 50) is not on the map.
    expect(
      master.containers.map((c) => [c.prefab, c.tx, c.ty, c.items.map((i) => [i.prefab, i.count])]),
    ).toEqual([
      ['icebox', 6, 5, [['meat', 2]]],
      ['treasurechest', 5, 6, [['log', 25]]],
      ['treasurechest', 7, 6, [['rocks', 5]]],
      ['chester', 6, 8, [['berries', 3]]],
    ]);
    expect(master.containers[0]!.name).toBe(
      recap.containers.find((c) => c.prefab === 'icebox')!.name,
    );
    expect(master.base).toEqual({ tx: 6, ty: 6 }); // the structures' centre, (-40, -40)
    // alice stopped at (40, 40) and dan at (60, -63) on the surface; bob in the caves.
    expect(master.stops).toEqual({ p1: { tx: 26, ty: 26 }, p3: { tx: 31, ty: 0 } });
    const caves = index.shards.caves!;
    expect(caves.base).toBeNull();
    expect(caves.stops).toEqual({ p2: { tx: 4, ty: 4 } });
    expect(caves.containers.map((c) => [c.prefab, c.tx, c.ty])).toEqual([['treasurechest', 4, 4]]);
  });

  it('has no notes beyond the expected first-session one', () => {
    expect(recap.notes).toEqual([
      'p3 has no save before this session (first session in this world)',
    ]);
  });
});

describe('digestSession: edge cases', () => {
  it('after: null (a crash with postStopVersionId null) -> partial, logs-only facts, no throw', async () => {
    const { recap, files } = await digestSession(
      scenarioInput({}, { after: null, manifest: { ...MANIFEST, postStopVersionId: null } }),
    );
    expect(recap.status).toBe('partial');
    expect(recap.notes).toContain('no post-session save: only the logs were digested');
    expect(recap.time.start?.day).toBe(5);
    expect(recap.time.end).toBeNull();
    expect(recap.time.daysPassed).toBeNull();
    expect(recap.built).toEqual([]);
    expect(recap.storage).toEqual([]);
    expect(recap.containers).toEqual([]);
    expect(recap.deaths).toHaveLength(3);
    // players known from the logs are still listed, without after-state
    expect(recap.players.map((p) => p.persona)).toEqual(['alice', 'bob']);
    const a = player(recap, 'alice');
    expect(a.presentAfter).toBe(false);
    expect(a.presentBefore).toBe(true);
    expect(a.carrying).toBeNull();
    expect(a.lastPosition).toBeNull();
    expect(a.stats).toBeNull();
    expect(a.newTiles).toEqual({ master: null, caves: null });
    expect(files).toEqual([]);
  });

  it('before: null -> partial, the start day comes from the boot log', async () => {
    const { recap } = await digestSession(scenarioInput({}, { before: null }));
    expect(recap.status).toBe('partial');
    expect(recap.notes).toContain(
      'the pre-session save is unavailable: nothing to compare against',
    );
    expect(recap.time.start).toEqual({
      day: 5,
      season: 'spring',
      dayOfSeason: null,
      daysLeftInSeason: null,
    });
    expect(recap.time.end?.day).toBe(9);
    expect(recap.built).toEqual([]);
    expect(recap.containers.length).toBeGreaterThan(0); // contents at the stop are still known
  });

  it('before: null does not report every known recipe as newly learned', async () => {
    // Without a pre-session save there is nothing to diff against: listing alice's whole recipe
    // book (Axe, Campfire, …) as "learned this session" would be a wrong fact.
    const { recap } = await digestSession(scenarioInput({}, { before: null }));
    for (const p of recap.players) expect(p.learned).toEqual([]);
  });

  it('a world without caves: hasCaves false, cave fields null', async () => {
    const { recap } = await digestSession(scenarioInput({ caves: false }));
    expect(recap.hasCaves).toBe(false);
    expect(recap.containers.every((c) => c.shard === 'master')).toBe(true);
    for (const p of recap.players) {
      expect(p.newTiles.caves).toBeNull();
      expect(p.totalTiles.caves).toBeNull();
      expect(p.caveTrips).toBe(0);
    }
    const b = player(recap, 'bob');
    expect(b.lastPosition?.shard).toBe('master');
    expect(b.carrying?.shard).toBe('master');
  });

  it('a session nobody played: players []', async () => {
    const same = saveTarZst(beforeSaveSpec());
    const { recap, players, files } = await digestSession(
      scenarioInput({}, { before: same, after: same, logs: NO_LOGS, knownPlayers: [] }),
    );
    expect(recap.players).toEqual([]);
    expect(players.players).toEqual([]);
    expect(recap.deaths).toEqual([]);
    expect(recap.built).toEqual([]);
    expect(recap.time.daysPassed).toBe(0);
    // No trail (nobody to draw it for); the map of the world is still written.
    expect(files.map((f) => f.path)).toEqual([
      'map/master.tiles.gz',
      'map/caves.tiles.gz',
      'map/index.json',
    ]);
  });

  it("the palette is by tile name, not by the save's ids, and follows each tile", async () => {
    const spec = afterSaveSpec();
    const w = spec.master!.worlds[17] as WorldSpec;
    // ids from DEFAULT_TILE_MAP: ROCKY 3, GRASS 6, FOREST 7; one row of each, the rest ocean.
    spec.master!.worlds[17] = {
      ...w,
      tiles: (_tx, ty) => [3, 6, 7][ty] ?? 201,
    };
    const { files } = await digestSession(scenarioInput({}, { after: saveTarZst(spec) }));
    const index = JSON.parse(
      files.find((f) => f.path === 'map/index.json')!.body.toString(),
    ) as RecapMapIndex;
    expect(index.shards.master!.palette).toEqual(['FOREST', 'GRASS', 'OCEAN_COASTAL', 'ROCKY']);
    const grid = gunzipSync(files.find((f) => f.path === 'map/master.tiles.gz')!.body);
    expect([grid[0], grid[32], grid[64], grid[96], grid[32 * 32 - 1]]).toEqual([4, 2, 1, 3, 3]);
  });

  it('a save without readable terrain costs the map, never the recap', async () => {
    const spec = afterSaveSpec();
    spec.master!.worlds[17] = { ...(spec.master!.worlds[17] as WorldSpec), tiles: null };
    const bad = afterSaveSpec();
    bad.caves!.worlds[3] = {
      ...(bad.caves!.worlds[3] as WorldSpec),
      tileMap: { GRASS: 99 }, // the grid's id 6 has no name
    };
    const missing = await digestSession(scenarioInput({}, { after: saveTarZst(spec) }));
    expect(missing.recap.status).toBe('ok');
    expect(missing.recap.built.length).toBeGreaterThan(0);
    expect(missing.recap.notes).toContain('no master map: tiles: missing');
    expect(missing.files.filter((f) => f.path.startsWith('map/')).map((f) => f.path)).toEqual([
      'map/caves.tiles.gz',
      'map/index.json',
    ]);
    const unnamed = await digestSession(scenarioInput({}, { after: saveTarZst(bad) }));
    expect(unnamed.recap.notes).toContain('no caves map: tiles: id 6 is not in world_tile_map');
  });

  it('continuous is true/false/null from the previous session’s postStopVersionId', async () => {
    const run = (prev: string | null | undefined) =>
      digestSession(scenarioInput({}, { previousPostStopVersionId: prev }));
    expect((await run('vPRE')).recap.continuous).toBe(true);
    const restored = (await run('vSOMETHING-ELSE')).recap;
    expect(restored.continuous).toBe(false);
    expect(restored.notes.some((n) => n.includes('restored or re-seeded'))).toBe(true);
    expect((await run(null)).recap.continuous).toBeNull();
    expect((await run(undefined)).recap.continuous).toBeNull();
  });

  it('without knownPlayers a log-less player stays anonymous and is noted', async () => {
    const { recap, players } = await digestSession(scenarioInput({}, { knownPlayers: [] }));
    // named players sort first, the anonymous one last
    expect(recap.players.map((p) => p.persona)).toEqual(['alice', 'bob', null]);
    const d = player(recap, null, 'p3');
    expect(d.persona).toBeNull();
    expect(d.character).toBe('wx78');
    expect(recap.notes).toContain('p3: no log line links this save to a Steam account');
    expect(players.players[2]).toEqual({
      ref: 'p3',
      ku: null,
      steamId64: null,
      persona: null,
      userdir: DIR.dan,
    });
  });

  it('knownPlayers also names a player whose userdir the logs never mention', async () => {
    const { recap } = await digestSession(
      scenarioInput({}, { knownPlayers: [{ ...DAN_KNOWN, persona: 'dan-from-last-time' }] }),
    );
    expect(recap.players.map((p) => p.persona)).toContain('dan-from-last-time');
  });

  it('notes a boot-log day that disagrees with the pre-session save', async () => {
    const logs = scenarioLogs();
    const { recap } = await digestSession(
      scenarioInput(
        {},
        {
          logs: { ...logs, masterServer: logText([[1, 'setting\tcycles\t9']]), cavesServer: null },
        },
      ),
    );
    expect(recap.notes).toContain('the boot log says day 10 but the pre-session save says day 5');
    expect(recap.time.start?.day).toBe(5); // the save wins
  });

  it('notes tiles visited before but not after, and an unrecognised savelocation byte', async () => {
    const after = afterSaveSpec();
    const aliceDir = after.master!.players![DIR.alice]!;
    (aliceDir.snapshots[17] as PlayerSpec).maps = [
      { shardSessionId: '00000000000000AA', bitmap: bitmap(32, 32, TILES.aliceBefore.slice(2)) },
    ];
    aliceDir.savelocation = 0x85;
    const { recap } = await digestSession(scenarioInput({}, { after: saveTarZst(after) }));
    expect(recap.notes).toContain('p1: 2 master tiles were visited before but not after');
    expect(recap.notes).toContain('unrecognised savelocation byte 0x85; fell back to the logs');
    expect(player(recap, 'alice').newTiles.master).toBe(0);
  });

  it('reports an unparsed announcement in notes', async () => {
    const logs = scenarioLogs();
    const { recap } = await digestSession(
      scenarioInput(
        {},
        { logs: { ...logs, masterChat: logText([[9, '[Death Announcement] alice ??? odd']]) } },
      ),
    );
    expect(recap.notes).toContain(
      'unrecognised chat announcement: [Death Announcement] alice ??? odd',
    );
  });

  it("skips a generated world's worldgen snapshot meta ({clock={},seasons={}})", async () => {
    const after = afterSaveSpec();
    const tar = saveTarZst({
      ...after,
      entries: [
        {
          path: 'Master/save/session/00000000000000AA/0000000002.meta',
          data: 'return {clock={},seasons={}} ',
        },
      ],
    });
    const { recap: base } = await digestSession(scenarioInput());
    const { recap: r } = await digestSession(scenarioInput({}, { after: tar }));
    expect(r.status).toBe('ok');
    expect(r.time).toEqual(base.time);
  });

  it('a save-format surprise throws SaveFormatError, never a partial recap', async () => {
    const after = afterSaveSpec();
    after.master!.worlds[17] = 'return {map={}, ents={}}';
    await expect(
      digestSession(scenarioInput({}, { after: saveTarZst(after) })),
    ).rejects.toBeInstanceOf(SaveFormatError);
    await expect(
      digestSession(scenarioInput({}, { before: Buffer.from('garbage') })),
    ).rejects.toBeInstanceOf(SaveFormatError);
    const badMeta = afterSaveSpec();
    badMeta.master!.metas = {};
    const tar = saveTarZst({
      ...badMeta,
      entries: [
        { path: 'Master/save/session/00000000000000AA/0000000017.meta', data: 'return {clock={}}' },
      ],
    });
    await expect(digestSession(scenarioInput({}, { after: tar }))).rejects.toThrow(
      /missing clock\/seasons|bad clock\/season/,
    );
  });
});

describe('digest helpers', () => {
  it('itemCondition rounds uses to 0.1, fuel and armor to integers, perish time to days', () => {
    expect(
      itemCondition({
        finiteuses: { uses: 12.345 },
        fueled: { fuel: 99.5 },
        armor: { condition: 0.4 },
        perishable: { time: 4800 },
      }),
    ).toEqual({ usesLeft: 12.3, fuel: 100, armor: 0, perishDaysLeft: 10 });
    expect(itemCondition({ perishable: { time: 24 } })).toEqual({ perishDaysLeft: 0.1 });
    expect(itemCondition({})).toBeUndefined();
    expect(itemCondition(null)).toBeUndefined();
  });

  it('toItem names the prefab and reads the stack', () => {
    expect(toItem(item('cutgrass', { stack: 3 }))).toEqual({
      prefab: 'cutgrass',
      name: 'Cut Grass',
      count: 3,
    });
    expect(toItem({ data: {} })).toBeNull();
    expect(toItem('log')).toBeNull();
  });

  it('carryingOf skips empty slots and returns null without an inventory', () => {
    expect(carryingOf({}, 'master')).toBeNull();
    expect(
      carryingOf({ inventory: { items: { '4': { prefab: 'log' }, '2': 'junk' } } }, 'caves'),
    ).toEqual({
      inventory: [{ prefab: 'log', name: 'Log', count: 1 }],
      equipped: [],
      backpack: null,
      shard: 'caves',
    });
  });

  it('baseCentre needs a cluster of at least 3 structures', () => {
    expect(baseCentre([])).toBeNull();
    expect(
      baseCentre([
        { prefab: 'campfire', x: 0, z: 0 },
        { prefab: 'tent', x: 10, z: 0 },
      ]),
    ).toBeNull();
    expect(
      baseCentre([
        { prefab: 'campfire', x: 0, z: 0 },
        { prefab: 'tent', x: 12, z: 0 },
        { prefab: 'icebox', x: 0, z: 12 },
        { prefab: 'campfire', x: 500, z: 500 },
      ]),
    ).toEqual({ x: 4, z: 4 });
  });
});

describe('noteAtDigest', () => {
  it('is the notes newline-joined (newest first), or null when there are none', async () => {
    const two = await digestSession(scenarioInput({}, { notes: ['newest', 'older'] }));
    expect(two.recap.noteAtDigest).toBe('newest\nolder');
    const none = await digestSession(scenarioInput({}, { notes: [] }));
    expect(none.recap.noteAtDigest).toBeNull();
  });
});
