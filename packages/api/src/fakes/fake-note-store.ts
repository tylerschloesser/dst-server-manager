// In-memory NoteStore (docs/control-plane.md §5.7). `local.ts`'s `/api/test/control` `reset`
// clears it.
import type { WorldNote } from '@dst/shared';

import type { NotePutInput, NoteStore } from '../ports';

export class FakeNoteStore implements NoteStore {
  private notes = new Map<string, WorldNote>();

  async get(worldId: string): Promise<WorldNote | null> {
    return this.notes.get(worldId) ?? null;
  }

  async put(a: NotePutInput): Promise<WorldNote> {
    const note: WorldNote = { text: a.text, updatedAt: a.updatedAt, updatedBy: a.updatedBy };
    this.notes.set(a.worldId, note);
    return note;
  }

  async clear(a: Omit<NotePutInput, 'text'>): Promise<void> {
    this.notes.delete(a.worldId);
  }

  reset(): void {
    this.notes.clear();
  }
}
