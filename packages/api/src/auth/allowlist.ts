// docs/auth.md §7: `/dst/users` re-checked on every request, module-scope cache keyed by the
// `AllowlistSource` instance (see secrets.ts for why a `WeakMap` gives the same real-world
// behaviour as a bare module-scope variable while staying trivially testable). Fails closed: on
// any validation failure, return `{}` (so every user gets 403) rather than throw, never cache the
// bad value, and never serve a stale good value past its TTL.
import { ALLOWLIST_TTL_MS, STEAMID64_RE } from './constants';

export interface AllowlistSource {
  getUsers(): Promise<Record<string, string>>;
}

interface CacheEntry {
  value: Record<string, string>;
  fetchedAtMs: number;
}

const cache = new WeakMap<AllowlistSource, CacheEntry>();
const inflight = new WeakMap<AllowlistSource, Promise<Record<string, string>>>();

function logAllowlistError(reason: string): void {
  console.log(JSON.stringify({ evt: 'auth.allowlist', error: reason }));
}

/** Returns `null` on any failure (already logged); never throws. */
async function fetchAndValidate(source: AllowlistSource): Promise<Record<string, string> | null> {
  let raw: Record<string, string>;
  try {
    raw = await source.getUsers();
  } catch (err) {
    logAllowlistError(err instanceof SyntaxError ? 'json' : 'ssm');
    return null;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    logAllowlistError('shape');
    return null;
  }

  for (const [k, v] of Object.entries(raw)) {
    if (!STEAMID64_RE.test(k) || typeof v !== 'string' || v.length === 0 || v.length > 32) {
      logAllowlistError('entry');
      return null;
    }
  }

  return raw;
}

/** docs/auth.md §7: `getUsers(): Promise<Record<string, string>>` with a 60 s cache. Takes the
 * clock as an explicit parameter (from `AuthDeps.nowMs`) so the cache TTL is testable without
 * touching the real wall clock. */
export async function getAllowlist(
  source: AllowlistSource,
  nowMs: () => number,
): Promise<Record<string, string>> {
  const now = nowMs();
  const cached = cache.get(source);
  if (cached !== undefined && now - cached.fetchedAtMs < ALLOWLIST_TTL_MS) {
    return cached.value;
  }

  const existing = inflight.get(source);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    try {
      const value = await fetchAndValidate(source);
      if (value === null) return {};
      cache.set(source, { value, fetchedAtMs: nowMs() });
      return value;
    } finally {
      inflight.delete(source);
    }
  })();
  inflight.set(source, promise);
  return promise;
}
