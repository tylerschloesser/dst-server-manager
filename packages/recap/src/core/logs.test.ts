import { describe, expect, it } from 'vitest';

import { logText } from '../test-support/synthetic';
import { dedupeEvents, parseChat, parseLogs } from './logs';
import type { ChatEvent } from './logs';

const NONE = { masterChat: null, cavesChat: null, masterServer: null, cavesServer: null };

describe('parseChat', () => {
  it('parses deaths, revives by someone and plain revives; skips other announcements', () => {
    const unparsed: string[] = [];
    const events = parseChat(
      logText([
        [5, '[Join Announcement] alice'],
        [600, '[Death Announcement] alice was killed by Hound. She became a spooky ghost!'],
        [610, '[Death Announcement] bob was killed by Darkness.'],
        [700, '[Resurrect Announcement] alice was resurrected by bob.'],
        [750, '[Resurrect Announcement] bob was resurrected.'],
        [760, '[Death Announcement] carol starved to death'],
        [800, '[Skin Announcement] alice received a gift'],
        [900, '[Leave Announcement] alice'],
      ]),
      unparsed,
    );
    expect(events).toEqual<ChatEvent[]>([
      { kind: 'death', seconds: 600, persona: 'alice', detail: 'Hound' },
      { kind: 'death', seconds: 610, persona: 'bob', detail: 'Darkness' },
      { kind: 'revive', seconds: 700, persona: 'alice', detail: 'bob' },
      { kind: 'revive', seconds: 750, persona: 'bob', detail: null },
      { kind: 'death', seconds: 760, persona: 'carol', detail: 'starved' },
    ]);
    expect(unparsed).toEqual([]);
  });

  it('sends an unrecognised announcement to `unparsed`, never guesses', () => {
    const unparsed: string[] = [];
    const events = parseChat(
      logText([
        [1, '[Death Announcement] something odd happened to alice'],
        [2, '[Resurrect Announcement] alice came back somehow!'],
      ]),
      unparsed,
    );
    expect(events).toEqual([]);
    expect(unparsed).toEqual([
      '[Death Announcement] something odd happened to alice',
      '[Resurrect Announcement] alice came back somehow!',
    ]);
  });

  it('reads hours:minutes:seconds, handles CRLF, and ignores lines without a timestamp', () => {
    const events = parseChat(
      '[01:02:03]: [Death Announcement] alice was killed by Frog.\r\nnoise\n',
      [],
    );
    expect(events).toEqual([{ kind: 'death', seconds: 3723, persona: 'alice', detail: 'Frog' }]);
  });
});

describe('dedupeEvents', () => {
  const d = (seconds: number, persona = 'alice', detail = 'Hound'): ChatEvent => ({
    kind: 'death',
    seconds,
    persona,
    detail,
  });

  it('drops a caves twin within 5 s but keeps a genuinely distinct caves-only event', () => {
    const out = dedupeEvents(
      [d(100), d(300, 'bob', 'Darkness')],
      [d(103), d(305, 'bob', 'Darkness'), d(200, 'bob', 'Cave Spider'), d(400)],
    );
    expect(out).toEqual([d(100), d(200, 'bob', 'Cave Spider'), d(300, 'bob', 'Darkness'), d(400)]);
  });

  it('a caves event 6 s away, or with another cause, is not a twin', () => {
    expect(dedupeEvents([d(100)], [d(106)])).toHaveLength(2);
    expect(dedupeEvents([d(100)], [d(101, 'alice', 'Frog')])).toHaveLength(2);
  });
});

describe('parseLogs', () => {
  const master = logText([
    [1, 'setting\tcycles\t52'],
    [1, 'setting\tseason\tspring'],
    [2, 'setting\tcycles\t99'], // only the first is the boot value
    [60, 'Client authenticated: (KU_TESTA0001) alice'],
    [
      61,
      '[ClientObject] Initialized (authenticated) on server: guid=1 userid=KU_TESTA0001 netid=76561190000000011 admin=1',
    ],
    [62, 'Resuming user: session/00000000000000AA/TESTUSERDIR1/0000000071'],
    [63, 'User ID\tKU_TESTA0001\tassigned ownership to entity\t120552 - wilson\t'],
    [70, 'Client authenticated: (KU_TESTB0002) bob'],
    [
      71,
      '[ClientObject] Initialized (authenticated) on server: guid=2 userid=KU_TESTB0002 netid=76561190000000022 admin=0',
    ],
    [72, 'Resuming user: session/00000000000000AA/TESTUSERDIR2/0000000071'],
    [73, 'User ID\tKU_TESTB0002\tassigned ownership to entity\t120600 - wendy\t'],
    [600, '[Shard] Migration request: (KU_TESTA0001) to Caves(2)'],
    [1200, '[Shard] Migration request: (KU_TESTB0002) to Caves(2)'],
    [1800, '[Shard] Migration request: (KU_TESTA0001) to Caves(2)'],
  ]);
  const caves = logText([
    [3, 'setting\tcycles\t52'],
    // what the Caves shard logs about the same moves: never counted as cave trips
    [590, '[Shard] Migration request: (KU_TESTA0001) to Caves(2)'],
    [900, '[Shard] Migration request: (KU_TESTA0001) to Master(1)'],
    [2400, '[Shard] Migration request: (KU_TESTA0001) to Master(1)'],
  ]);

  it('reads the boot cycles/season from TAB-separated setting lines', () => {
    const out = parseLogs({ ...NONE, masterServer: master });
    expect(out.bootCycles).toBe(52);
    expect(out.bootSeason).toBe('spring');
    expect(parseLogs({ ...NONE, cavesServer: caves }).bootCycles).toBe(52);
    expect(
      parseLogs({ ...NONE, masterServer: logText([[1, 'setting cycles 7']]) }).bootCycles,
    ).toBe(7);
    expect(parseLogs(NONE).bootCycles).toBeNull();
  });

  it('links KU -> persona, SteamID64, and userdir -> character', () => {
    const out = parseLogs({ ...NONE, masterServer: master });
    const a = out.identities.get('KU_TESTA0001')!;
    expect(a.persona).toBe('alice');
    expect(a.steamId64).toBe('76561190000000011');
    expect(Object.fromEntries(a.userdirs)).toEqual({ TESTUSERDIR1: 'wilson' });
    const b = out.identities.get('KU_TESTB0002')!;
    expect(Object.fromEntries(b.userdirs)).toEqual({ TESTUSERDIR2: 'wendy' });
  });

  it('an ownership line without a preceding Resuming line links no userdir', () => {
    const out = parseLogs({
      ...NONE,
      masterServer: logText([
        [1, 'User ID\tKU_TESTC0003\tassigned ownership to entity\t1 - wolfgang\t'],
      ]),
    });
    expect(out.identities.get('KU_TESTC0003')).toBeUndefined();
  });

  it('counts cave trips from Master "to Caves" lines only; lastShard from the latest move', () => {
    const out = parseLogs({ ...NONE, masterServer: master, cavesServer: caves });
    expect(out.caveTrips.get('KU_TESTA0001')).toBe(2);
    expect(out.caveTrips.get('KU_TESTB0002')).toBe(1);
    expect(out.lastShard.get('KU_TESTA0001')).toBe('master'); // back up at 2400
    expect(out.lastShard.get('KU_TESTB0002')).toBe('caves');
    // a player who never migrated has no lastShard
    expect(parseLogs({ ...NONE, masterServer: master }).lastShard.has('KU_TESTC0003')).toBe(false);
  });

  it('dedupes chat across shards and only reports Master unparsed lines', () => {
    const chat = logText([
      [600, '[Death Announcement] alice was killed by Hound. She became a spooky ghost!'],
      [650, '[Death Announcement] weird line'],
    ]);
    const cavesChat = logText([
      [601, '[Death Announcement] alice was killed by Hound. She became a spooky ghost!'],
      [651, '[Death Announcement] weird line'],
      [900, '[Death Announcement] bob was killed by Cave Spider.'],
    ]);
    const out = parseLogs({ ...NONE, masterChat: chat, cavesChat });
    expect(out.events.map((e) => `${e.persona}:${e.detail}@${e.seconds}`)).toEqual([
      'alice:Hound@600',
      'bob:Cave Spider@900',
    ]);
    expect(out.unparsed).toEqual(['[Death Announcement] weird line']);
  });
});
