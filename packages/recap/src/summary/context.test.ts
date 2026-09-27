// Asserts the FACTS the fact sheet carries (numbers, names, structure), not its exact wording,
// which is tuned in the prompt lab.
import { describe, expect, it } from 'vitest';

import type { Recap } from '@dst/shared';

import { digestSession } from '../core/digest';
import { beforeSaveSpec, scenarioInput } from '../test-support/scenario';
import { saveTarZst } from '../test-support/synthetic';
import { DEFAULT_CONTEXT_OPTIONS, buildContext, factSheet, playerLabel } from './context';
import type { ContextOptions } from './context';

const NO_LOGS = { masterChat: null, cavesChat: null, masterServer: null, cavesServer: null };
const opts = (over: Partial<ContextOptions> = {}): ContextOptions => ({
  ...DEFAULT_CONTEXT_OPTIONS,
  ...over,
});

describe('factSheet / buildContext', async () => {
  const { recap } = await digestSession(scenarioInput());
  const same = saveTarZst(beforeSaveSpec());
  const { recap: idle } = await digestSession(
    scenarioInput({}, { before: same, after: same, logs: NO_LOGS, knownPlayers: [] }),
  );
  const prev = (id: string): Recap => ({ ...recap, sessionId: id });

  it('states the session, calendar, season change and what comes next', () => {
    const s = factSheet(recap, opts());
    expect(s).toContain(recap.sessionId);
    expect(s).toContain('2026-01-01');
    expect(s).toMatch(/60 min/);
    expect(s).toContain('idle');
    expect(s).toMatch(/day 5\b[^\n]*spring[^\n]*day 9\b[^\n]*summer/);
    expect(s).toMatch(/summer[^\n]*day 8/);
    expect(s).toMatch(/autumn[^\n]*13 days/);
  });

  it('states deaths with cause, minute and who revived whom', () => {
    const s = factSheet(recap, opts());
    expect(s).toMatch(/alice[^\n]*Hound[^\n]*10 min[^\n]*bob[^\n]*3 min/);
    expect(s).toMatch(/bob[^\n]*Darkness[^\n]*not revived/);
    expect(s).toMatch(/bob[^\n]*Cave Spider[^\n]*revived 5 min/);
  });

  it('states what was built and what is gone, and storage changes and contents', () => {
    const s = factSheet(recap, opts());
    expect(s).toContain('Fire Pit x2');
    expect(s).toContain('Science Machine x1');
    expect(s).toContain('Birdcage x1');
    expect(s).toMatch(/Log \+15[^\n]*Twigs -7/);
    expect(s).toMatch(/Chest x2 \(surface\): Log 25, Rocks 5/);
    expect(s).toMatch(/Chest x1 \(caves\): Flint 4/);
    expect(s).toMatch(/Chester x1[^\n]*Berries 3/);
    expect(s).not.toContain('Conspicuous Chest');
  });

  it('has per-player lines: character, learned, tiles, positions, stats', () => {
    const s = factSheet(recap, opts());
    expect(s).toContain('alice (Wilson P. Higgsbury)');
    expect(s).toContain('bob (Wendy)');
    expect(s).toContain('dan (WX-78)');
    expect(s).toMatch(/alice learned: Ice Box, Chest/);
    expect(s).toMatch(/5 new surface tiles/);
    expect(s).toMatch(/4 new cave tiles/);
    expect(s).toMatch(/cave trips: 1/);
    expect(s).toMatch(/day 6 surface Rocky \(base\)/);
    expect(s).toMatch(/day 9 caves Sinkhole/);
    expect(s).toMatch(/health 100, hunger 50, sanity 80/);
  });

  it('the storage options limit and drop sections', () => {
    const limited = factSheet(recap, opts({ storageChanges: 2 }));
    expect(limited).toMatch(/Log \+15, Twigs -7, and 3 smaller changes/);
    const none = factSheet(recap, opts({ storageChanges: 0, containers: false }));
    expect(none).not.toContain('Twigs -7');
    expect(none).not.toContain('Rocks 5');
  });

  it("inventory levels 'none' < 'brief' < 'full' differ", () => {
    const none = factSheet(recap, opts({ inventory: 'none' }));
    const brief = factSheet(recap, opts({ inventory: 'brief' }));
    const full = factSheet(recap, opts({ inventory: 'full' }));
    expect(new Set([none, brief, full]).size).toBe(3);
    expect(none).not.toContain('Football Helmet');
    expect(brief).toContain('Football Helmet');
    expect(brief).toMatch(/Meat[^\n]*2\.5/); // food with its freshness
    expect(brief).not.toContain('Cut Grass'); // backpack contents only in full
    expect(full).toContain('Cut Grass x10');
    expect(full).toMatch(/Torch[^\n]*fuel 45/);
    expect(full).toContain('Log x20');
  });

  it('the compact form (previous sessions) omits storage and per-player detail', () => {
    const compact = factSheet(recap, opts(), false);
    expect(compact).toContain('Fire Pit x2');
    expect(compact).not.toContain('Log +15');
    expect(compact).not.toContain('health 100');
    expect(compact.length).toBeLessThan(factSheet(recap, opts()).length);
  });

  it('a session nobody played says so and lists no players', () => {
    const s = factSheet(idle, opts());
    expect(s).toMatch(/nobody/i);
    expect(s).not.toContain('alice');
    expect(s).not.toMatch(/^Players:/m);
  });

  it('marks a restored world and a partial digest', () => {
    const s = factSheet(
      { ...recap, continuous: false, status: 'partial', notes: ['X-NOTE'] },
      opts(),
    );
    expect(s).toMatch(/restored/);
    expect(s).toContain('X-NOTE');
  });

  it('playerLabel falls back to "Player n" without a persona', () => {
    const p = recap.players[0]!;
    expect(playerLabel({ ...p, persona: null, ref: 'p7', characterName: null })).toBe('Player 7');
    expect(playerLabel(p)).toBe('alice (Wilson P. Higgsbury)');
  });

  it('buildContext: previous summaries (oldest first) where present, fact sheets otherwise', () => {
    const { text, contextSessions } = buildContext(
      {
        recap,
        note: '  finish the farm  ',
        previous: [
          { recap: prev('s1'), summary: 'OLDEST SUMMARY' },
          { recap: prev('s2'), summary: 'SUMMARY TWO' },
          { recap: prev('s3'), summary: null },
        ],
      },
      opts({ previous: 'summaries', previousCount: 2 }),
    );
    expect(contextSessions).toEqual(['s2', 's3']);
    expect(text).not.toContain('OLDEST SUMMARY');
    expect(text).toContain('SUMMARY TWO');
    expect(text).toMatch(/<session id="s3"[^>]*>\nSession s3/); // no summary -> facts
    expect(text.indexOf('s2')).toBeLessThan(text.indexOf('<session id="s3"'));
    expect(text).toContain('<players_note>\nfinish the farm\n</players_note>');
    // previous sessions, then the note, then this session
    expect(text.indexOf('</previous_sessions>')).toBeLessThan(text.indexOf('<players_note>'));
    expect(text.indexOf('<players_note>')).toBeLessThan(text.indexOf('<this_session>'));
  });

  it("buildContext: 'digests' uses fact sheets even when summaries exist; 'none' skips history", () => {
    const input = { recap, note: null, previous: [{ recap: prev('s1'), summary: 'A SUMMARY' }] };
    const digests = buildContext(input, opts({ previous: 'digests' }));
    expect(digests.text).not.toContain('A SUMMARY');
    expect(digests.text).toMatch(/<session id="s1"[^>]*>\nSession s1/);
    expect(digests.contextSessions).toEqual(['s1']);
    const none = buildContext(input, opts({ previous: 'none' }));
    expect(none.text).not.toContain('<previous_sessions>');
    expect(none.contextSessions).toEqual([]);
  });

  it('buildContext: no note (null or blank) reads (none)', () => {
    for (const note of [null, '', '   ']) {
      const { text } = buildContext({ recap, note, previous: [] }, opts());
      expect(text).toContain('<players_note>(none)</players_note>');
      expect(text).not.toContain('<previous_sessions>');
    }
  });
});
