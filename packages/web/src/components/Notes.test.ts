import { describe, expect, it } from 'vitest';
import type { WorldNote } from '@dst/shared';
import { noteMeta } from './Notes';

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
