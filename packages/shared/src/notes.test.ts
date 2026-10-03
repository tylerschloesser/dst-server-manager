// docs/control-plane.md §5.7: the notes item is parsed identically by the API and the digest.
import { describe, expect, it } from 'vitest';

import { applyNoteEdit, parseNotesItem } from './notes';

describe('parseNotesItem', () => {
  it('reads an absent item as no notes', () => {
    expect(parseNotesItem(undefined)).toEqual([]);
    expect(parseNotesItem({ pk: 'NOTE', sk: 'w' })).toEqual([]);
  });

  it('folds a legacy single note into one note with id "legacy"', () => {
    expect(
      parseNotesItem({ pk: 'NOTE', sk: 'w', text: 'bring ice', updatedAt: 't1', updatedBy: 'Ni' }),
    ).toEqual([
      {
        id: 'legacy',
        text: 'bring ice',
        createdAt: 't1',
        createdBy: 'Ni',
        editedAt: null,
        editedBy: null,
      },
    ]);
    // A cleared legacy note (text REMOVEd, or blank) is no note.
    expect(parseNotesItem({ updatedAt: 't', updatedBy: 'Ni' })).toEqual([]);
    expect(parseNotesItem({ text: '  ' })).toEqual([]);
  });

  it('prefers the notes map over a stray legacy text', () => {
    const notes = parseNotesItem({ text: 'old', notes: {} });
    expect(notes).toEqual([]);
  });

  it('sorts newest first, ties by id, and keeps edit fields', () => {
    const notes = parseNotesItem({
      notes: {
        a: { text: 'old', createdAt: '2026-10-01T00:00:00Z', createdBy: 'Ni' },
        c: { text: 'tie-c', createdAt: '2026-10-02T00:00:00Z', createdBy: 'Ni' },
        b: {
          text: 'tie-b',
          createdAt: '2026-10-02T00:00:00Z',
          createdBy: 'Tyler',
          editedAt: '2026-10-03T00:00:00Z',
          editedBy: 'Ni',
        },
      },
    });
    expect(notes.map((n) => n.id)).toEqual(['c', 'b', 'a']);
    expect(notes[1]).toMatchObject({ editedAt: '2026-10-03T00:00:00Z', editedBy: 'Ni' });
    expect(notes[0]).toMatchObject({ editedAt: null, editedBy: null });
  });

  it('drops malformed entries', () => {
    const notes = parseNotesItem({
      notes: {
        ok: { text: 'fine', createdAt: 't' },
        empty: { text: '', createdAt: 't' },
        notext: { createdAt: 't' },
        scalar: 'nope',
        nul: null,
      },
    });
    expect(notes.map((n) => n.id)).toEqual(['ok']);
    expect(notes[0]?.createdBy).toBeNull();
  });
});

describe('applyNoteEdit', () => {
  const note = { text: 'a', createdAt: 't0', createdBy: 'Tyler' };

  it('a self-edit stamps editedAt and omits editedBy', () => {
    const out = applyNoteEdit(note, 'b', 'Tyler', 't1');
    expect(out).toEqual({ text: 'b', createdAt: 't0', createdBy: 'Tyler', editedAt: 't1' });
    expect('editedBy' in out).toBe(false);
  });

  it('an edit by someone else records them', () => {
    expect(applyNoteEdit(note, 'b', 'Ni', 't1')).toEqual({
      text: 'b',
      createdAt: 't0',
      createdBy: 'Tyler',
      editedAt: 't1',
      editedBy: 'Ni',
    });
  });

  it('a self-edit after someone else clears their editedBy', () => {
    const byNi = applyNoteEdit(note, 'b', 'Ni', 't1');
    expect(applyNoteEdit(byNi, 'c', 'Tyler', 't2').editedBy).toBeUndefined();
  });
});
