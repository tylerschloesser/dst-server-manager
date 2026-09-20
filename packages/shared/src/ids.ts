// @dst/shared: id formats and helpers (docs/control-plane.md §1.2, decisions §16.3).
import { randomBytes } from 'node:crypto';

import { TEST_WORLD_PREFIX, WORLD_ID_RE } from './constants';

export function isValidWorldId(id: string): boolean {
  return WORLD_ID_RE.test(id);
}

export function isTestWorldId(id: string): boolean {
  return id.startsWith(TEST_WORLD_PREFIX);
}

/** decisions §16.3: `YYYYMMDDTHHMMSSZ-<6 lowercase hex>` in UTC, e.g. `20260919T201355Z-a1b2c3`. */
export const SESSION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0');
}

/**
 * Mints a sessionId. The format is deliberate: it sorts chronologically (so a `sessions/<worldId>/`
 * prefix lists in order), it is a valid EC2 `ClientToken` (23 chars, well under the 64-char
 * limit), and it is the S3 session log prefix. Never `crypto.randomUUID()`.
 */
export function newSessionId(now: Date): string {
  const datePart =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const hex = randomBytes(3).toString('hex');
  return `${datePart}-${hex}`;
}

/** The inverse of `newSessionId`: parses a well-formed sessionId back into its parts, or `null`. */
export function parseSessionId(id: string): { timestamp: Date; hex: string } | null {
  if (!SESSION_ID_RE.test(id)) return null;
  const year = Number(id.slice(0, 4));
  const month = Number(id.slice(4, 6));
  const day = Number(id.slice(6, 8));
  const hour = Number(id.slice(9, 11));
  const minute = Number(id.slice(11, 13));
  const second = Number(id.slice(13, 15));
  const hex = id.slice(17);
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return { timestamp, hex };
}
