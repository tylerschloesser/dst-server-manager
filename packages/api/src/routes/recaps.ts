// GET /api/worlds/{id}/recaps and the three note writes (docs/control-plane.md §5.6, §5.7).
import { RECAPS_DEFAULT_LIMIT, RECAPS_MAX_LIMIT } from '@dst/shared';
import type { NotesResponse, RecapsResponse } from '@dst/shared';

import { ApiError } from '../errors';
import type { Clock, NoteStore, RecapStore } from '../ports';
import { parseNoteHeader } from '../recaps/note';
import { toRecapEntry } from '../recaps/view';

export interface RecapsDeps {
  clock: Clock;
  recaps: RecapStore;
  notes: NoteStore;
  /** A new note's id; `crypto.randomUUID()` unless a test injects one. */
  newId?: () => string;
}

/** Absent or empty -> RECAPS_DEFAULT_LIMIT. A whole number is clamped to 1..RECAPS_MAX_LIMIT.
 *  Anything else (`abc`, `2.5`, `-1`) is a 400 `invalid_limit`: a typo should be loud, a large
 *  but well-formed value just gets the maximum. */
export function parseLimit(rawQueryString: string | undefined): number {
  const raw = new URLSearchParams(rawQueryString ?? '').get('limit');
  if (raw === null || raw === '') return RECAPS_DEFAULT_LIMIT;
  if (!/^\d{1,6}$/.test(raw)) throw new ApiError('invalid_limit');
  return Math.min(RECAPS_MAX_LIMIT, Math.max(1, Number(raw)));
}

export async function buildRecapsResponse(
  deps: RecapsDeps,
  worldId: string,
  limit: number,
  nicknames: Record<string, string>,
): Promise<RecapsResponse> {
  const [stored, notes] = await Promise.all([
    deps.recaps.listRecent(worldId, limit),
    deps.notes.list(worldId),
  ]);
  return {
    worldId,
    notes,
    recaps: stored.map((s) => toRecapEntry(s, worldId, nicknames)),
  };
}

function noteText(rawHeader: string | undefined): string {
  const parsed = parseNoteHeader(rawHeader);
  if (!parsed.ok) throw new ApiError('invalid_note', parsed.message);
  return parsed.text;
}

export async function addNote(
  deps: RecapsDeps,
  worldId: string,
  rawHeader: string | undefined,
  user: { nickname: string },
): Promise<NotesResponse> {
  const text = noteText(rawHeader);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const notes = await deps.notes.add(worldId, id, {
    text,
    createdAt: deps.clock.now().toISOString(),
    createdBy: user.nickname,
  });
  return { notes };
}

export async function editNote(
  deps: RecapsDeps,
  worldId: string,
  noteId: string,
  rawHeader: string | undefined,
  user: { nickname: string },
): Promise<NotesResponse> {
  const text = noteText(rawHeader);
  const now = deps.clock.now().toISOString();
  const notes = await deps.notes.edit(worldId, noteId, text, user.nickname, now);
  if (notes === null) throw new ApiError('note_not_found');
  return { notes };
}

export async function deleteNote(
  deps: RecapsDeps,
  worldId: string,
  noteId: string,
): Promise<NotesResponse> {
  return { notes: await deps.notes.remove(worldId, noteId) };
}
