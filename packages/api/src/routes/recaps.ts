// GET /api/worlds/{id}/recaps and POST /api/worlds/{id}/note (docs/control-plane.md §5.6, §5.7).
import { RECAPS_DEFAULT_LIMIT, RECAPS_MAX_LIMIT } from '@dst/shared';
import type { NoteResponse, RecapsResponse } from '@dst/shared';

import { ApiError } from '../errors';
import type { Clock, NoteStore, RecapStore } from '../ports';
import { parseNoteHeader } from '../recaps/note';
import { toRecapEntry } from '../recaps/view';

export interface RecapsDeps {
  clock: Clock;
  recaps: RecapStore;
  notes: NoteStore;
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
  const [stored, note] = await Promise.all([
    deps.recaps.listRecent(worldId, limit),
    deps.notes.get(worldId),
  ]);
  return {
    worldId,
    note,
    recaps: stored.map((s) => toRecapEntry(s, worldId, nicknames)),
  };
}

export async function saveNote(
  deps: RecapsDeps,
  worldId: string,
  rawHeader: string | undefined,
  user: { nickname: string },
): Promise<NoteResponse> {
  const parsed = parseNoteHeader(rawHeader);
  if (!parsed.ok) throw new ApiError('invalid_note', parsed.message);
  const updatedAt = deps.clock.now().toISOString();
  if (parsed.text === '') {
    await deps.notes.clear({ worldId, updatedAt, updatedBy: user.nickname });
    return { note: null };
  }
  const note = await deps.notes.put({
    worldId,
    text: parsed.text,
    updatedAt,
    updatedBy: user.nickname,
  });
  return { note };
}
