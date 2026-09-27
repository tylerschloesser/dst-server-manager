import { describe, expect, it } from 'vitest';
import type { RecapDeath, RecapPlayerView, RecapView } from '@dst/shared';
import {
  conditionText,
  containerGroupText,
  countedName,
  dailyBiomesText,
  deathText,
  deltaText,
  itemText,
  newTilesText,
  playerLabel,
  realMinutesText,
  recapDetails,
  recapHeadline,
  stopReasonText,
  topChanges,
} from './recap-format';

const MINUS = String.fromCharCode(0x2212);

function time(partial: Partial<RecapView['time']> = {}): Pick<RecapView, 'time'> {
  return {
    time: {
      start: { day: 53, season: 'spring', dayOfSeason: 18, daysLeftInSeason: 2 },
      end: { day: 60, season: 'summer', dayOfSeason: 5, daysLeftInSeason: 10 },
      daysPassed: 7,
      seasonChanges: [{ season: 'summer', day: 56 }],
      ...partial,
    },
  };
}

function player(partial: Partial<RecapPlayerView>): RecapPlayerView {
  return {
    ref: 'p1',
    persona: null,
    character: null,
    characterName: null,
    presentBefore: true,
    presentAfter: true,
    newTiles: { master: null, caves: null },
    totalTiles: { master: null, caves: null },
    dailyPositions: [],
    lastPosition: null,
    learned: [],
    carrying: null,
    deaths: 0,
    revives: 0,
    caveTrips: 0,
    stats: null,
    nickname: null,
    ...partial,
  };
}

describe('recapHeadline', () => {
  it('shows the day span and the season change', () => {
    expect(recapHeadline(time())).toBe('Days 53 → 60 · spring → summer');
  });

  it('collapses a single day and a single season', () => {
    const same = { day: 60, season: 'summer', dayOfSeason: 5, daysLeftInSeason: 10 };
    expect(recapHeadline(time({ start: same, end: same }))).toBe('Day 60 · summer');
  });

  it('falls back when the calendar is unknown', () => {
    expect(recapHeadline(time({ start: null, end: null }))).toBe('Session recap');
  });
});

describe('recapDetails', () => {
  it('season starts, real time and the stop reason in plain words', () => {
    const session = {
      startedAt: null,
      joinableAt: null,
      stoppedAt: null,
      stopReason: 'idle',
      realMinutes: 64,
      peakPlayers: 2,
      startedBy: null,
      dstBuildId: null,
    };
    expect(recapDetails({ ...time(), session })).toEqual([
      'summer began day 56',
      '1 h 4 min real time',
      'ended once everyone left',
    ]);
  });

  it('realMinutesText / stopReasonText edge cases', () => {
    expect(realMinutesText(42)).toBe('42 min');
    expect(realMinutesText(120)).toBe('2 h');
    expect(realMinutesText(null)).toBeNull();
    expect(stopReasonText('crash')).toBe('the server crashed');
    expect(stopReasonText('something-new')).toBeNull();
    expect(stopReasonText(null)).toBeNull();
  });
});

describe('conditionText / itemText', () => {
  it('uses, freshness, armor and fuel', () => {
    expect(conditionText({ usesLeft: 20 })).toBe('20 uses');
    expect(conditionText({ usesLeft: 1 })).toBe('1 use');
    expect(conditionText({ perishDaysLeft: 4.5 })).toBe('spoils in 4.5 d');
    expect(conditionText({ perishDaysLeft: 3 })).toBe('spoils in 3 d');
    expect(conditionText({ perishDaysLeft: 0 })).toBe('spoiled');
    expect(conditionText({ armor: 410, fuel: 62.25 })).toBe('armor 410 · fuel 62.3');
    expect(conditionText({})).toBeNull();
    expect(conditionText(undefined)).toBeNull();
  });

  it('item with count and condition', () => {
    expect(itemText({ prefab: 'log', name: 'Log', count: 17 })).toBe('Log ×17');
    expect(
      itemText({
        prefab: 'meatballs',
        name: 'Meatballs',
        count: 3,
        condition: { perishDaysLeft: 4.5 },
      }),
    ).toBe('Meatballs ×3 (spoils in 4.5 d)');
  });
});

describe('lists', () => {
  it('deltaText uses a real minus sign', () => {
    expect(deltaText(18)).toBe('+18');
    expect(deltaText(-28)).toBe(`${MINUS}28`);
    expect(deltaText(0)).toBe('0');
  });

  it('countedName', () => {
    expect(countedName({ prefab: 'c', name: 'Chest', delta: 1 })).toBe('Chest');
    expect(countedName({ prefab: 'c', name: 'Chest', delta: -2 })).toBe('Chest ×2');
  });

  it('topChanges keeps the biggest absolute changes and counts the rest', () => {
    const list = [1, -30, 5, 20, -2].map((delta, i) => ({ prefab: `p${i}`, name: `n${i}`, delta }));
    const { shown, more } = topChanges(list, 3);
    expect(shown.map((s) => s.delta)).toEqual([-30, 20, 5]);
    expect(more).toBe(2);
  });

  it('containerGroupText shows the top items and folds the rest', () => {
    const items = [5, 60, 40, 30, 25, 18, 14, 12].map((delta, i) => ({
      prefab: `p${i}`,
      name: `Item${i}`,
      delta,
    }));
    expect(
      containerGroupText({
        prefab: 'treasurechest',
        name: 'Chest',
        shard: 'master',
        containers: 5,
        items,
      }),
    ).toBe(
      'Chest ×5 (surface): Item1 60, Item2 40, Item3 30, Item4 25, Item5 18, Item6 14, and 2 more',
    );
    expect(
      containerGroupText({
        prefab: 'chester',
        name: 'Chester',
        shard: 'caves',
        containers: 1,
        items: [],
      }),
    ).toBe('Chester (caves): empty');
  });
});

describe('players', () => {
  it('playerLabel: nickname, then persona, then Player N', () => {
    expect(playerLabel({ nickname: 'Ally', persona: 'alice' }, 0)).toBe('Ally');
    expect(playerLabel({ nickname: null, persona: 'bob' }, 1)).toBe('bob');
    expect(playerLabel({ nickname: null, persona: null }, 2)).toBe('Player 3');
  });

  it('dailyBiomesText marks base and caves', () => {
    expect(
      dailyBiomesText([
        { day: 57, shard: 'master', biome: 'Rocky', atBase: false },
        { day: 58, shard: 'master', biome: 'Grass', atBase: true },
        { day: 59, shard: 'caves', biome: null, atBase: false },
      ]),
    ).toBe('57 Rocky · 58 Grass (base) · 59 somewhere (caves)');
    expect(dailyBiomesText([])).toBeNull();
  });

  it('newTilesText', () => {
    expect(newTilesText({ newTiles: { master: 857, caves: 42 } })).toBe(
      '857 new tiles · 42 in the caves',
    );
    expect(newTilesText({ newTiles: { master: 1, caves: 0 } })).toBe('1 new tile');
    expect(newTilesText({ newTiles: { master: null, caves: null } })).toBeNull();
  });

  it('deathText resolves the victim by ref and the reviver by persona', () => {
    const players = [
      player({ ref: 'p1', persona: 'alice', nickname: 'Ally' }),
      player({ ref: 'p2', persona: 'bob' }),
    ];
    const death: RecapDeath = {
      player: 'p2',
      persona: 'bob',
      cause: 'Overheating',
      minute: 41,
      revivedBy: 'alice',
      revivedAfterMinutes: 4,
    };
    expect(deathText(death, players)).toBe('bob: Overheating, revived by Ally after 4 min');
    expect(deathText({ ...death, player: null, persona: 'carol', revivedBy: null }, players)).toBe(
      'carol: Overheating, not revived',
    );
  });
});
