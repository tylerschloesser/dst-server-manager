// One synthetic play session, before and after (docs/research/save-anatomy.md), used by the digest
// and pipeline tests. Invented from scratch: players "alice", "bob", "carol", "dan"; KU_TEST ids;
// fake SteamID64s; 16-hex shard session ids made of zeros; userdirs TESTUSERDIRn.
//
// The story (numbers the tests assert by hand):
//   calendar  day 5 spring -> day 9 summer (summer began on day 8)
//   base      7 placeables clustered around (-40, -40) on the surface
//   built     Fire Pit x2, Chest, Ice Box, Science Machine; gone: Birdcage
//   storage   Log +15, Twigs -7, Rocks +5, Berries +3 (Chester), Meat +2; rabbits 5 -> 9 ignored
//   alice     wilson, learned Chest + Ice Box, 5 new surface tiles, died to a Hound, revived by bob
//   bob       wendy, learned Spear, went to the caves (4 new cave tiles), died twice
//   carol     has an old save and did not play: excluded
//   dan       first session (after only), no log lines: identified only via knownPlayers
import type { DigestInput, ManifestLike } from '../core/digest';
import type { SessionLogs } from '../core/logs';
import { bitmap, item, logText, saveTarZst } from './synthetic';
import type { LuaValue, PlayerSpec, SaveSpec, ShardSaveSpec, WorldSpec } from './synthetic';

export const MASTER_SID = '00000000000000AA';
export const CAVES_SID = '00000000000000BB';
export const KU = { alice: 'KU_TESTA0001', bob: 'KU_TESTB0002', dan: 'KU_TESTD0004' };
export const STEAM = {
  alice: '76561190000000011',
  bob: '76561190000000022',
  dan: '76561190000000044',
};
export const DIR = {
  alice: 'TESTUSERDIR1',
  bob: 'TESTUSERDIR2',
  carol: 'TESTUSERDIR3',
  dan: 'TESTUSERDIR4',
};

export const MASTER_TOPOLOGY = ['Dig that rock:7:Rocky', 'X:BG_1:BGGrass', 'Y:3:DeepForest'];
const masterNodes = (tx: number, ty: number) => (ty === 0 ? 0 : ty >= 24 ? 3 : tx < 16 ? 1 : 2);

function masterWorld(ents: WorldSpec['ents']): WorldSpec {
  return { width: 32, height: 32, nodeIds: masterNodes, topology: MASTER_TOPOLOGY, ents };
}
function cavesWorld(): WorldSpec {
  return {
    width: 8,
    height: 8,
    nodeIds: () => 1,
    topology: ['Cave:1:BGSinkhole'],
    ents: { treasurechest: [{ x: 0, z: 0, items: [item('flint', { stack: 4 })] }] },
  };
}

const rabbits = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 20 + i, z: 20 }));
const terrarium = { x: 50, z: 50, items: [item('goldnugget', { stack: 1 })] };

export const BEFORE_MASTER = masterWorld({
  campfire: [{ x: -40, z: -40 }],
  treasurechest: [
    { x: -44, z: -40, items: [item('log', { stack: 10 }), item('twigs', { stack: 7 })] },
  ],
  birdcage: [{ x: -36, z: -44 }],
  rabbit: rabbits(5),
  terrariumchest: [terrarium],
});

export const AFTER_MASTER = masterWorld({
  campfire: [{ x: -40, z: -40 }],
  treasurechest: [
    { x: -44, z: -40, items: [item('log', { stack: 25 })] },
    { x: -36, z: -40, items: [item('rocks', { stack: 5 })] },
  ],
  icebox: [{ x: -40, z: -44, items: [item('meat', { stack: 2 })] }],
  firepit: [
    { x: -40, z: -36 },
    { x: -42, z: -42 },
  ],
  researchlab: [{ x: -38, z: -38 }],
  rabbit: rabbits(9),
  terrariumchest: [terrarium],
  chester: [{ x: -40, z: -30, items: [item('berries', { stack: 3 })] }],
});

type Meta = ShardSaveSpec['metas'][number];
const spring = (cycles: number): Meta => ({
  cycles,
  season: 'spring',
  elapsed: cycles,
  remaining: 19 - cycles,
});
const summer = (cycles: number): Meta => ({
  cycles,
  season: 'summer',
  elapsed: cycles - 7,
  remaining: 14 - (cycles - 7),
});

const row = (y: number, from: number, to: number): [number, number][] =>
  Array.from({ length: to - from }, (_, i) => [from + i, y]);

export const TILES = {
  aliceBefore: row(6, 0, 10),
  aliceNew: row(6, 10, 15),
  bobMaster: row(10, 0, 3),
  bobCaves: row(0, 0, 4),
  dan: row(20, 0, 2),
};
const mbm = (tiles: [number, number][]) => bitmap(32, 32, tiles);
const cbm = (tiles: [number, number][]) => bitmap(8, 8, tiles);

const ALICE_INVENTORY: Pick<PlayerSpec, 'items' | 'equip'> = {
  items: new Map<number, LuaValue>([
    [1, item('log', { stack: 20 })],
    [3, item('axe', { data: { finiteuses: { uses: 80 } } })],
    [6, item('meat', { data: { perishable: { time: 1200 } } })],
    [7, item('berries', { stack: 4, data: { perishable: { time: 100 } } })],
  ]),
  equip: {
    hands: item('spear', { data: { finiteuses: { uses: 75.55 } } }),
    head: item('footballhat', { data: { armor: { condition: 315.4 } } }),
    body: {
      prefab: 'backpack',
      data: {
        container: {
          items: new Map<number, LuaValue>([
            [3, item('cutgrass', { stack: 10 })],
            [1, item('torch', { data: { fueled: { fuel: 44.6 } } })],
          ]),
        },
      },
    },
  },
};

function alice(x: number, z: number, after: boolean): PlayerSpec {
  return {
    x,
    z,
    prefab: 'wilson',
    recipes: after ? ['axe', 'campfire', 'treasurechest', 'icebox'] : ['axe', 'campfire'],
    ...(after ? ALICE_INVENTORY : { items: [item('log', { stack: 2 })] }),
    health: 100,
    hunger: 50.4,
    sanity: 80,
    maps: [
      {
        shardSessionId: MASTER_SID,
        bitmap: mbm(after ? [...TILES.aliceBefore, ...TILES.aliceNew] : TILES.aliceBefore),
      },
    ],
  };
}

function bob(x: number, z: number, after: boolean, inCaves: boolean): PlayerSpec {
  return {
    x,
    z,
    prefab: 'wendy',
    recipes: after ? ['axe', 'spear'] : ['axe'],
    items: [item('flint', { stack: 2 })],
    maps: [
      ...(inCaves ? [{ shardSessionId: CAVES_SID, bitmap: cbm(TILES.bobCaves) }] : []),
      { shardSessionId: MASTER_SID, bitmap: mbm(TILES.bobMaster) },
    ],
  };
}

const carol: PlayerSpec = { x: -40, z: -40, prefab: 'willow', recipes: ['axe'] };

export interface ScenarioOptions {
  caves?: boolean;
}

export function beforeSaveSpec(opts: ScenarioOptions = {}): SaveSpec {
  const caves = opts.caves ?? true;
  return {
    master: {
      sessionId: MASTER_SID,
      worlds: { 10: 'return {}', 11: 'return {}', 12: BEFORE_MASTER },
      metas: { 10: spring(2), 11: spring(3), 12: spring(4) },
      players: {
        [DIR.alice]: {
          snapshots: { 11: alice(-40, -40, false), 12: alice(-40, -40, false) },
          savelocation: 0x81,
        },
        [DIR.bob]: {
          snapshots: { 11: bob(-40, -40, false, false), 12: bob(-40, -40, false, false) },
          savelocation: 0x81,
        },
        [DIR.carol]: { snapshots: { 12: carol }, savelocation: 0x81 },
      },
    },
    ...(caves
      ? {
          caves: {
            sessionId: CAVES_SID,
            worlds: { 2: cavesWorld() },
            metas: { 2: spring(4) },
          },
        }
      : {}),
  };
}

export function afterSaveSpec(opts: ScenarioOptions = {}): SaveSpec {
  const caves = opts.caves ?? true;
  return {
    master: {
      sessionId: MASTER_SID,
      worlds: {
        12: 'return {}',
        13: 'return {}',
        14: 'return {}',
        15: 'return {}',
        16: 'return {}',
        17: AFTER_MASTER,
      },
      metas: {
        12: spring(4),
        13: spring(5),
        14: spring(6),
        15: summer(7),
        16: summer(8),
        17: summer(8),
      },
      players: {
        [DIR.alice]: {
          snapshots: {
            12: alice(-40, -40, false), // older than the before save's newest: excluded
            13: alice(-40, -40, true),
            14: alice(40, -40, true),
            15: alice(0, 60, true),
            16: alice(-38, -38, true),
            17: alice(40, 40, true),
          },
          savelocation: 0x81,
        },
        [DIR.bob]: {
          snapshots: {
            12: bob(-40, -40, false, false),
            13: bob(40, -40, true, false),
            14: bob(40, -40, true, false),
          },
          savelocation: caves ? 0x82 : 0x81,
        },
        [DIR.carol]: { snapshots: { 12: carol }, savelocation: 0x81 },
        [DIR.dan]: {
          snapshots: {
            16: {
              x: 60,
              z: -63,
              prefab: 'wx78',
              recipes: ['axe', 'torch'],
              maps: [{ shardSessionId: MASTER_SID, bitmap: mbm(TILES.dan) }],
            },
          },
          savelocation: 0x81,
        },
      },
    },
    ...(caves
      ? {
          caves: {
            sessionId: CAVES_SID,
            worlds: { 2: 'return {}', 3: cavesWorld() },
            metas: { 2: spring(4), 3: summer(8) },
            players: { [DIR.bob]: { snapshots: { 3: bob(1, 1, true, true) } } },
          },
        }
      : {}),
  };
}

export function scenarioLogs(opts: ScenarioOptions = {}): SessionLogs {
  const caves = opts.caves ?? true;
  const join = (who: 'alice' | 'bob', t: number, character: string): [number, string][] => [
    [t, `Client authenticated: (${KU[who]}) ${who}`],
    [
      t + 1,
      `[ClientObject] Initialized (authenticated) on server: guid=${t} userid=${KU[who]} netid=${STEAM[who]} admin=1`,
    ],
    [t + 2, `Resuming user: session/${MASTER_SID}/${DIR[who]}/0000000012`],
    [t + 3, `User ID\t${KU[who]}\tassigned ownership to entity\t${100000 + t} - ${character}\t`],
  ];
  const masterServer = logText([
    [1, 'setting\tcycles\t4'],
    [1, 'setting\tseason\tspring'],
    ...join('alice', 60, 'wilson'),
    ...join('bob', 70, 'wendy'),
    ...(caves
      ? ([[1200, `[Shard] Migration request: (${KU.bob}) to Caves(2)`]] as [number, string][])
      : []),
  ]);
  const cavesServer = caves
    ? logText([
        [3, 'setting\tcycles\t4'],
        [1195, `[Shard] Migration request: (${KU.bob}) to Caves(2)`],
      ])
    : null;
  const shared: [number, string][] = [
    [600, '[Death Announcement] alice was killed by Hound. She became a spooky ghost!'],
    [780, '[Resurrect Announcement] alice was resurrected by bob.'],
    [1800, '[Death Announcement] bob was killed by Darkness.'],
    [2700, '[Resurrect Announcement] bob was resurrected.'],
  ];
  const masterChat = logText([[5, '[Join Announcement] alice'], ...shared]);
  const cavesChat = caves
    ? logText([
        ...shared.map(([t, l]): [number, string] => [t + 1, l]),
        [2400, '[Death Announcement] bob was killed by Cave Spider.'],
      ])
    : null;
  return { masterChat, cavesChat, masterServer, cavesServer };
}

export const MANIFEST: ManifestLike = {
  sessionId: '20260101T000000Z-abc123',
  worldId: 'test-recap',
  startedBy: 'alice-nick',
  startedAt: '2026-01-01T00:00:00.000Z',
  joinableAt: '2026-01-01T00:02:30.000Z',
  stoppedAt: '2026-01-01T01:02:30.000Z',
  stopReason: 'idle',
  peakPlayers: 2,
  dstBuildId: '000000',
  preStartVersionId: 'vPRE',
  postStopVersionId: 'vPOST',
};

export const DAN_KNOWN = {
  ref: 'p9',
  ku: KU.dan,
  steamId64: STEAM.dan,
  persona: 'dan',
  userdir: DIR.dan,
};

export const NOW = new Date('2026-01-01T01:05:00.000Z');

/** A complete `digestSession` input for the scenario; override anything. */
export function scenarioInput(
  opts: ScenarioOptions = {},
  overrides: Partial<DigestInput> = {},
): DigestInput {
  return {
    worldId: 'test-recap',
    sessionId: MANIFEST.sessionId!,
    manifest: MANIFEST,
    before: saveTarZst(beforeSaveSpec(opts)),
    after: saveTarZst(afterSaveSpec(opts)),
    logs: scenarioLogs(opts),
    previousPostStopVersionId: 'vPRE',
    knownPlayers: [DAN_KNOWN],
    notes: ['finish the farm'],
    now: NOW,
    ...overrides,
  };
}
