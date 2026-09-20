// Central safety guard for scripts/lifecycle-test.ts (docs/testing.md §4.1 rule 2): "Every world
// id it registers, starts, stops or deletes must match /^test-[a-z0-9-]{0,27}$/. A central
// assertTestKey(key) guards every mutating S3/DynamoDB call and throws on anything else, before
// the call is made." `worlds/tylerni2026/`, `seed/` and any non-`test-` registry item are never
// read and never written by that script.
//
// Accepts either a bare world id (a DynamoDB `sk`) or an S3 object key under `worlds/`,
// `inflight/` or `sessions/` — the three prefixes the lifecycle test ever writes to or deletes
// from. Anything else (a different prefix, `seed/*`, a non-test world id) is refused.

/** docs/testing.md §4.1 rule 2, verbatim. Deliberately stricter than @dst/shared's WORLD_ID_RE
 * (max 32 chars total vs. the general 1..32): this is the lifecycle test's own, narrower rail. */
export const TEST_WORLD_ID_RE = /^test-[a-z0-9-]{0,27}$/;

const TEST_KEY_PREFIX_RE = /^(worlds|inflight|sessions)\/([^/]+)\//;

function isTestWorldId(id: string): boolean {
  return TEST_WORLD_ID_RE.test(id);
}

/**
 * Throws unless `key` is safely scoped to lifecycle-test data. Guards every mutating S3 and
 * DynamoDB call in `scripts/lifecycle-test.ts` (docs/testing.md §4.1 rule 2) before the call is
 * made — never after, and never as a best-effort check.
 *
 * - A bare id (no `/`) must be a test world id: `TEST_WORLD_ID_RE`.
 * - An S3 key must start with `worlds/`, `inflight/` or `sessions/`, followed by a test world id
 *   and a `/`. Every other prefix — including `seed/`, `binaries/`, `runtime/` and any bucket-root
 *   key — is refused, even if it happens to contain the substring `test-` somewhere else.
 */
export function assertTestKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`refuses a non-test key: ${JSON.stringify(key)}`);
  }

  if (!key.includes('/')) {
    if (isTestWorldId(key)) return;
    throw new Error(`refuses a non-test key: ${key}`);
  }

  const match = TEST_KEY_PREFIX_RE.exec(key);
  if (match !== null && isTestWorldId(match[2]!)) return;
  throw new Error(`refuses a non-test key: ${key}`);
}
