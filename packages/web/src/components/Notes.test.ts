import { describe, expect, it } from 'vitest';
import type { WorldNote } from '@dst/shared';
import { noteMeta, splitNotes } from './Notes';

const base: WorldNote = {
  id: 'a',
  text: 'x',
  createdAt: '2026-10-03T12:00:00.000Z',
  createdBy: 'Tyler',
  editedAt: null,
  editedBy: null,
};

describe('noteMeta', () => {
  it('is author · date, then "edited" or "edited by <them>"', () => {
    expect(noteMeta(base, 'en-US')).toBe('Tyler · Oct 3');
    expect(noteMeta({ ...base, editedAt: '2026-10-04T00:00:00Z' }, 'en-US')).toBe(
      'Tyler · Oct 3 · edited',
    );
    expect(noteMeta({ ...base, editedAt: '2026-10-04T00:00:00Z', editedBy: 'Ni' }, 'en-US')).toBe(
      'Tyler · Oct 3 · edited by Ni',
    );
  });

  it('survives a note with no author or date', () => {
    expect(noteMeta({ ...base, createdBy: null, createdAt: '' }, 'en-US')).toBe('Someone');
  });
});

describe('splitNotes', () => {
  const SINCE = '2026-10-03T04:09:45.000Z';
  const n = (id: string, createdAt: string, editedAt: string | null = null): WorldNote => ({
    ...base,
    id,
    createdAt,
    editedAt,
  });
  // newest first, as the API returns them
  const notes = [
    n('new', '2026-10-03T05:03:55.000Z'),
    n('mid', '2026-09-30T04:35:33.462Z'),
    n('revived', '2026-09-29T04:29:14.077Z', '2026-10-03T06:00:00.000Z'),
    n('oldest', '2026-09-27T22:01:44.051Z'),
  ];

  it('keeps every note current without a recap', () => {
    expect(splitNotes(notes, null)).toEqual({ current: notes, old: [] });
  });

  it('splits at the cutoff, keeps newest-first order on both sides, and revives edited notes', () => {
    const { current, old } = splitNotes(notes, SINCE);
    expect(current.map((x) => x.id)).toEqual(['new', 'revived']);
    expect(old.map((x) => x.id)).toEqual(['mid', 'oldest']);
  });
});
