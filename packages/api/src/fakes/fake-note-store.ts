// In-memory NoteStore (docs/control-plane.md §5.7). `local.ts`'s `/api/test/control` `reset`
// clears it. It reads through the same `parseNotesItem` and `applyNoteEdit` as the Dynamo adapter.
import { NOTES_MAX, applyNoteEdit, parseNotesItem } from '@dst/shared';
import type { StoredNote, WorldNote } from '@dst/shared';

import { ApiError } from '../errors';
import type { NoteStore } from '../ports';

export class FakeNoteStore implements NoteStore {
  private items = new Map<string, Record<string, StoredNote>>();

  private map(worldId: string): Record<string, StoredNote> {
    let m = this.items.get(worldId);
    if (m === undefined) {
      m = {};
      this.items.set(worldId, m);
    }
    return m;
  }

  async list(worldId: string): Promise<WorldNote[]> {
    return parseNotesItem({ notes: this.items.get(worldId) ?? {} });
  }

  async add(worldId: string, id: string, note: StoredNote): Promise<WorldNote[]> {
    const m = this.map(worldId);
    if (Object.keys(m).length >= NOTES_MAX) throw new ApiError('too_many_notes');
    m[id] = { ...note };
    return this.list(worldId);
  }

  async edit(
    worldId: string,
    id: string,
    text: string,
    editor: string,
    now: string,
  ): Promise<WorldNote[] | null> {
    const m = this.map(worldId);
    const current = m[id];
    if (current === undefined) return null;
    m[id] = applyNoteEdit(current, text, editor, now);
    return this.list(worldId);
  }

  async remove(worldId: string, id: string): Promise<WorldNote[]> {
    delete this.map(worldId)[id];
    return this.list(worldId);
  }

  reset(): void {
    this.items.clear();
  }
}
