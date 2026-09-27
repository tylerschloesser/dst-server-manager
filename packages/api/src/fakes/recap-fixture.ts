// SYNTHETIC recap fixture for local dev, e2e and unit tests (docs/control-plane.md §5.6). Every
// name, id and number here is invented: personas "alice"/"bob", KU ids `KU_TEST…`, SteamID64s in
// the obviously-fake `7656119000000000x` range. Nothing comes from a real save.
//
// Layout it seeds (the same keys the digest Lambda writes):
//   sessions/test-a/20260927T033435Z-000002/digest/{recap,players,summary}.json + summary.md  newest
//   sessions/test-a/20260920T190000Z-000001/digest/{recap,players,summary}.json               older, summary unavailable
//   sessions/test-a/20260913T180000Z-000000/digest/recap.json                                 schemaVersion 99 -> skipped
//   sessions/test-a/20260906T180000Z-00000f/manifest.json                                     no digest -> skipped
//   (test-b: nothing -> empty list)
import type { Recap, RecapPlayer, RecapPlayersFile, RecapSummaryMeta } from '@dst/shared';

import { digestKey } from '../recaps/store';

/** On `local.ts`'s allowlist as "Ally", so alice is labelled by her nickname, not her persona.
 *  Deliberately NOT the dev user ("Dev"): e2e scenario 3 finds the header nickname by text. */
export const FIXTURE_STEAMID_ALICE = '76561190000000003';
/** Not on the local allowlist: bob is labelled by his persona. */
export const FIXTURE_STEAMID_BOB = '76561190000000002';
export const FIXTURE_KU_ALICE = 'KU_TESTALICE1';
export const FIXTURE_KU_BOB = 'KU_TESTBOB01';

export const FIXTURE_WORLD_ID = 'test-a';
export const FIXTURE_SESSION_NEW = '20260927T033435Z-000002';
export const FIXTURE_SESSION_OLD = '20260920T190000Z-000001';
export const FIXTURE_SESSION_BAD = '20260913T180000Z-000000';
export const FIXTURE_SESSION_NO_DIGEST = '20260906T180000Z-00000f';

const alice: RecapPlayer = {
  ref: 'p1',
  persona: 'alice',
  character: 'wathgrithr',
  characterName: 'Wigfrid',
  presentBefore: true,
  presentAfter: true,
  newTiles: { master: 857, caves: 42 },
  totalTiles: { master: 12040, caves: 1310 },
  dailyPositions: [
    { day: 57, shard: 'master', biome: 'Rocky', atBase: false },
    { day: 58, shard: 'master', biome: 'Grass', atBase: true },
    { day: 59, shard: 'caves', biome: 'Mushroom', atBase: false },
    { day: 60, shard: 'master', biome: 'Forest', atBase: false },
  ],
  lastPosition: { day: 60, shard: 'master', biome: 'Grass', atBase: true },
  learned: [
    { prefab: 'coldfirepit', name: 'Endothermic Fire Pit' },
    { prefab: 'boards', name: 'Boards' },
  ],
  carrying: {
    inventory: [
      { prefab: 'axe', name: 'Axe', count: 1, condition: { usesLeft: 20 } },
      { prefab: 'meatballs', name: 'Meatballs', count: 3, condition: { perishDaysLeft: 4.5 } },
      { prefab: 'log', name: 'Log', count: 17 },
      { prefab: 'cutgrass', name: 'Cut Grass', count: 40 },
      { prefab: 'torch', name: 'Torch', count: 1, condition: { fuel: 62 } },
    ],
    equipped: [
      {
        slot: 'hands',
        item: {
          prefab: 'spear_wathgrithr',
          name: 'Battle Spear',
          count: 1,
          condition: { usesLeft: 113 },
        },
      },
      {
        slot: 'head',
        item: { prefab: 'wathgrithrhat', name: 'Battle Helm', count: 1, condition: { armor: 410 } },
      },
      { slot: 'body', item: { prefab: 'backpack', name: 'Backpack', count: 1 } },
    ],
    backpack: {
      prefab: 'backpack',
      name: 'Backpack',
      items: [
        { prefab: 'rocks', name: 'Rocks', count: 22 },
        { prefab: 'flint', name: 'Flint', count: 9 },
        { prefab: 'ice', name: 'Ice', count: 6, condition: { perishDaysLeft: 0.8 } },
      ],
    },
    shard: 'master',
  },
  deaths: 0,
  revives: 1,
  caveTrips: 2,
  stats: { health: 280, hunger: 91, sanity: 150 },
};

const bob: RecapPlayer = {
  ref: 'p2',
  persona: 'bob',
  character: 'wilson',
  characterName: 'Wilson',
  presentBefore: true,
  presentAfter: true,
  newTiles: { master: 223, caves: 0 },
  totalTiles: { master: 9120, caves: 870 },
  dailyPositions: [
    { day: 57, shard: 'master', biome: 'Grass', atBase: true },
    { day: 58, shard: 'master', biome: 'Savanna', atBase: false },
    { day: 60, shard: 'master', biome: 'Grass', atBase: true },
  ],
  lastPosition: { day: 60, shard: 'master', biome: 'Grass', atBase: true },
  learned: [{ prefab: 'coldfirepit', name: 'Endothermic Fire Pit' }],
  carrying: {
    inventory: [
      { prefab: 'pickaxe', name: 'Pickaxe', count: 1, condition: { usesLeft: 7 } },
      { prefab: 'berries', name: 'Berries', count: 5, condition: { perishDaysLeft: 1.5 } },
    ],
    equipped: [
      {
        slot: 'head',
        item: { prefab: 'strawhat', name: 'Straw Hat', count: 1, condition: { perishDaysLeft: 3 } },
      },
    ],
    backpack: null,
    shard: 'master',
  },
  deaths: 1,
  revives: 0,
  caveTrips: 0,
  stats: { health: 75, hunger: 60, sanity: 120 },
};

export const FIXTURE_RECAP_NEW: Recap = {
  schemaVersion: 1,
  digestVersion: 'fixture-1',
  worldId: FIXTURE_WORLD_ID,
  sessionId: FIXTURE_SESSION_NEW,
  generatedAt: '2026-09-27T04:41:00.000Z',
  hasCaves: true,
  session: {
    startedAt: '2026-09-27T03:34:35.000Z',
    joinableAt: '2026-09-27T03:37:20.000Z',
    stoppedAt: '2026-09-27T04:41:20.000Z',
    stopReason: 'idle',
    realMinutes: 64,
    peakPlayers: 2,
    startedBy: 'Ally',
    dstBuildId: '700000',
  },
  continuous: true,
  status: 'ok',
  notes: [],
  time: {
    start: { day: 53, season: 'spring', dayOfSeason: 18, daysLeftInSeason: 2 },
    end: { day: 60, season: 'summer', dayOfSeason: 5, daysLeftInSeason: 10 },
    daysPassed: 7,
    seasonChanges: [{ season: 'summer', day: 56 }],
  },
  built: [
    { prefab: 'coldfirepit', name: 'Endothermic Fire Pit', delta: 1 },
    { prefab: 'treasurechest', name: 'Chest', delta: 1 },
  ],
  destroyed: [{ prefab: 'birdtrap', name: 'Bird Trap', delta: -1 }],
  storage: [
    { prefab: 'thulecite_pieces', name: 'Thulecite Fragments', delta: 18 },
    { prefab: 'spoiled_food', name: 'Rot', delta: 35 },
    { prefab: 'lightbulb', name: 'Light Bulb', delta: -28 },
    { prefab: 'ice', name: 'Ice', delta: -21 },
    { prefab: 'moonglass', name: 'Moon Shard', delta: 3 },
    { prefab: 'log', name: 'Log', delta: 12 },
    { prefab: 'rocks', name: 'Rocks', delta: -10 },
    { prefab: 'goldnugget', name: 'Gold Nugget', delta: 4 },
    { prefab: 'silk', name: 'Silk', delta: 2 },
    { prefab: 'petals', name: 'Petals', delta: -6 },
  ],
  deaths: [
    {
      player: 'p2',
      persona: 'bob',
      cause: 'Overheating',
      minute: 41,
      revivedBy: 'alice',
      revivedAfterMinutes: 4,
    },
  ],
  players: [alice, bob],
  noteAtDigest: null,
};

export const FIXTURE_RECAP_OLD: Recap = {
  ...FIXTURE_RECAP_NEW,
  sessionId: FIXTURE_SESSION_OLD,
  generatedAt: '2026-09-20T20:10:00.000Z',
  session: {
    ...FIXTURE_RECAP_NEW.session,
    startedAt: '2026-09-20T19:00:00.000Z',
    joinableAt: '2026-09-20T19:02:40.000Z',
    stoppedAt: '2026-09-20T20:09:00.000Z',
    stopReason: 'user',
    realMinutes: 66,
  },
  continuous: false,
  status: 'partial',
  notes: ['no post-stop save: deltas unavailable'],
  time: {
    start: { day: 46, season: 'spring', dayOfSeason: 11, daysLeftInSeason: 9 },
    end: { day: 53, season: 'spring', dayOfSeason: 18, daysLeftInSeason: 2 },
    daysPassed: 7,
    seasonChanges: [],
  },
  built: [],
  destroyed: [],
  storage: [],
  deaths: [],
  players: [{ ...alice, carrying: null, dailyPositions: [], learned: [] }],
};

export const FIXTURE_PLAYERS: RecapPlayersFile = {
  schemaVersion: 1,
  players: [
    { ref: 'p1', ku: FIXTURE_KU_ALICE, steamId64: FIXTURE_STEAMID_ALICE, persona: 'alice' },
    { ref: 'p2', ku: FIXTURE_KU_BOB, steamId64: FIXTURE_STEAMID_BOB, persona: 'bob' },
  ],
};

export const FIXTURE_SUMMARY_MD = [
  '## Previously on World A',
  '- Summer arrived on **day 56**; bob died of _Overheating_ and alice revived him.',
  '- You built an **Endothermic Fire Pit** and a Chest at base.',
  '- alice spent two trips in the caves and came back with thulecite.',
  '',
  '### Open threads',
  '- Ice is running low (−21 this session) (inferred)',
  '- 10 days of summer left: more cooling near base may help (inferred)',
].join('\n');

export const FIXTURE_SUMMARY_META_OK: RecapSummaryMeta = {
  status: 'ok',
  model: 'fixture-model',
  promptVersion: 'fixture-p1',
  generatedAt: '2026-09-27T04:41:05.000Z',
  latencyMs: 1200,
  usage: {
    inputTokens: 1000,
    outputTokens: 120,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  costUsd: 0.001,
  contextSessions: [FIXTURE_SESSION_OLD],
};

export const FIXTURE_SUMMARY_META_UNAVAILABLE: RecapSummaryMeta = {
  status: 'unavailable',
  reason: 'no_api_key',
  detail: null,
  promptVersion: 'fixture-p1',
  generatedAt: '2026-09-20T20:10:05.000Z',
};

/** Every object the fixture seeds, key -> body, as an S3 bucket would hold them. */
export function recapFixtureObjects(): Map<string, string> {
  const w = FIXTURE_WORLD_ID;
  const json = (v: unknown) => JSON.stringify(v);
  return new Map<string, string>([
    [digestKey(w, FIXTURE_SESSION_NEW, 'recap.json'), json(FIXTURE_RECAP_NEW)],
    [digestKey(w, FIXTURE_SESSION_NEW, 'players.json'), json(FIXTURE_PLAYERS)],
    [digestKey(w, FIXTURE_SESSION_NEW, 'summary.json'), json(FIXTURE_SUMMARY_META_OK)],
    [digestKey(w, FIXTURE_SESSION_NEW, 'summary.md'), FIXTURE_SUMMARY_MD],
    [digestKey(w, FIXTURE_SESSION_OLD, 'recap.json'), json(FIXTURE_RECAP_OLD)],
    [digestKey(w, FIXTURE_SESSION_OLD, 'players.json'), json(FIXTURE_PLAYERS)],
    [digestKey(w, FIXTURE_SESSION_OLD, 'summary.json'), json(FIXTURE_SUMMARY_META_UNAVAILABLE)],
    [
      digestKey(w, FIXTURE_SESSION_BAD, 'recap.json'),
      json({ ...FIXTURE_RECAP_OLD, schemaVersion: 99, sessionId: FIXTURE_SESSION_BAD }),
    ],
    [`sessions/${w}/${FIXTURE_SESSION_NO_DIGEST}/manifest.json`, json({ synthetic: true })],
  ]);
}
