// The per-world "next time" notes item (docs/control-plane.md §5.7), parsed in one place so the API
// and the digest Lambda read it identically: `{ pk: 'NOTE', sk: worldId, notes: { <id>: { text,
// createdAt, createdBy, editedAt?, editedBy? } } }`. A legacy single-note item (`text`,
// `updatedAt`, `updatedBy`, no `notes` map) reads as one note with id `legacy` until its first write
// migrates it (docs/follow-ups.md §15).
import type { WorldNote } from './recap';

export const LEGACY_NOTE_ID = 'legacy';

/** A note as stored in the `notes` map (its id is the map key). */
export interface StoredNote {
  text: string;
  createdAt: string;
  createdBy: string | null;
  editedAt?: string;
  editedBy?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The legacy item's single note as a map entry, or null when it has none. */
export function legacyNote(item: Record<string, unknown>): StoredNote | null {
  const text = str(item['text']);
  if (text === null || text.trim() === '') return null;
  return {
    text,
    createdAt: str(item['updatedAt']) ?? '',
    createdBy: str(item['updatedBy']),
  };
}

/** Item -> notes, newest first (`createdAt` desc, then `id`). Malformed entries are dropped. */
export function parseNotesItem(item: Record<string, unknown> | undefined): WorldNote[] {
  if (item === undefined) return [];
  const map = item['notes'];
  let entries: [string, unknown][];
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    entries = Object.entries(map as Record<string, unknown>);
  } else {
    const legacy = legacyNote(item);
    entries = legacy === null ? [] : [[LEGACY_NOTE_ID, legacy]];
  }
  const notes: WorldNote[] = [];
  for (const [id, raw] of entries) {
    if (raw === null || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const text = str(n['text']);
    if (text === null || text === '') continue;
    notes.push({
      id,
      text,
      createdAt: str(n['createdAt']) ?? '',
      createdBy: str(n['createdBy']),
      editedAt: str(n['editedAt']),
      editedBy: str(n['editedBy']),
    });
  }
  // An edit keeps a note's place; sorting by `editedAt ?? createdAt` would move it to the top.
  return notes.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt < b.createdAt
        ? 1
        : -1
      : a.id < b.id
        ? 1
        : a.id > b.id
          ? -1
          : 0,
  );
}

/** The edit rule: `editedAt` is always stamped; `editedBy` only when the editor is not the
 *  author (a self-edit shows "edited", another player's shows "edited by <them>"). */
export function applyNoteEdit(
  note: StoredNote,
  text: string,
  editor: string,
  now: string,
): StoredNote {
  const out: StoredNote = {
    text,
    createdAt: note.createdAt,
    createdBy: note.createdBy,
    editedAt: now,
  };
  if (editor !== note.createdBy) out.editedBy = editor;
  return out;
}

/** WorldNote -> the map entry it came from (omitting absent edit fields). */
export function toStoredNote(n: WorldNote): StoredNote {
  const out: StoredNote = { text: n.text, createdAt: n.createdAt, createdBy: n.createdBy };
  if (n.editedAt !== null) out.editedAt = n.editedAt;
  if (n.editedBy !== null) out.editedBy = n.editedBy;
  return out;
}

/** When a note was last touched: an edit counts as a fresh write. */
export function noteTouchedAt(n: WorldNote): string {
  return n.editedAt ?? n.createdAt;
}

/** The current/old rule (docs/control-plane.md §5.7): a note is current when it was touched at or
 *  after `since` (ISO strings compare lexically); a null or empty cutoff makes every note current.
 *  The page's cutoff is the latest recap's `startedAt`, the digest's the previous session's. */
export function isCurrentNote(n: WorldNote, since: string | null): boolean {
  return since === null || since === '' || noteTouchedAt(n) >= since;
}
