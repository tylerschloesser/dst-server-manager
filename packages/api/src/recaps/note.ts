// The "next time" note travels URI-encoded in the `x-dst-note` header (docs/control-plane.md §5.7)
// because no request in this app has a body (docs/decisions.md §10: CloudFront OAC would need an
// `x-amz-content-sha256` of it). This is the one place it is decoded and normalized.
import { NOTE_MAX_CHARS } from '@dst/shared';

/** Anything longer than this, still encoded, cannot decode to NOTE_MAX_CHARS characters (a code
 *  point is at most 4 UTF-8 bytes = 12 encoded chars); refuse it before decoding. */
const MAX_ENCODED_LENGTH = NOTE_MAX_CHARS * 12;

// C0/C1 controls (newlines and tabs included), then the invisible bidi overrides/isolates and
// zero-width characters that could make a note render differently from what was typed.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export type ParsedNote = { ok: true; text: string } | { ok: false; message: string };

/** `undefined` (header absent) and `''` both mean "clear the note": some hops drop an empty-valued
 *  header, and the SPA always sends the header, so an absent one can only be an emptied note. */
export function parseNoteHeader(raw: string | undefined): ParsedNote {
  if (raw === undefined || raw === '') return { ok: true, text: '' };
  if (raw.length > MAX_ENCODED_LENGTH) {
    return { ok: false, message: `Note is longer than ${NOTE_MAX_CHARS} characters` };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, message: 'Note is not URI-encoded' };
  }
  const text = decoded.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > NOTE_MAX_CHARS) {
    return { ok: false, message: `Note is longer than ${NOTE_MAX_CHARS} characters` };
  }
  return { ok: true, text };
}
