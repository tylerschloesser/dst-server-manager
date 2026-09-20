// docs/auth.md §4. The secret arrives through a port, so this module has no `APP_ENV` branch and
// no reference of any kind to the test secret (decisions §16.37). Caches are keyed by the
// `SecretSource` instance (a `WeakMap`) rather than being a single bare module-scope variable:
// in production there is exactly one `SecretSource` for the Lambda's lifetime, so this behaves
// exactly like the module-scope cache the doc describes, while in tests each fake source gets its
// own isolated cache entry without needing `vi.resetModules()` between cases.
import { hkdfSync } from 'node:crypto';

import type { AppEnv } from './constants';
import { SECRET_TTL_MS } from './constants';

export interface SecretSource {
  read(): Promise<string>;
}

export interface DerivedKeys {
  sessionKey: Buffer;
  stateKey: Buffer;
}

interface CacheEntry {
  value: string;
  fetchedAtMs: number;
}

const cache = new WeakMap<SecretSource, CacheEntry>();
const inflight = new WeakMap<SecretSource, Promise<string>>();

/** docs/auth.md §4: module-scope `{ value, fetchedAtMs }` cache, TTL `SECRET_TTL_MS`, plus an
 * in-flight promise so concurrent calls make one `read()`. Empty or missing -> throw. There is no
 * environment-variable fallback anywhere in this module. */
export async function getSessionSecret(source: SecretSource): Promise<string> {
  const cached = cache.get(source);
  const now = Date.now();
  if (cached !== undefined && now - cached.fetchedAtMs < SECRET_TTL_MS) {
    return cached.value;
  }

  const existing = inflight.get(source);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    try {
      const value = await source.read();
      if (value === '') {
        throw new Error('missing session secret');
      }
      cache.set(source, { value, fetchedAtMs: Date.now() });
      return value;
    } finally {
      inflight.delete(source);
    }
  })();
  inflight.set(source, promise);
  return promise;
}

/** docs/auth.md §4: both keys from the one secret, domain-separated by `APP_ENV`. */
export function deriveKeys(secret: string, appEnv: AppEnv): DerivedKeys {
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.from('dst-v1', 'utf8');
  const sessionKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from(`${appEnv}:session`, 'utf8'), 32),
  );
  const stateKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from(`${appEnv}:state`, 'utf8'), 32),
  );
  return { sessionKey, stateKey };
}

/** Derived keys are cached alongside the secret and re-derived whenever it is re-read (docs/auth.md
 * §4) — since `deriveKeys` is cheap, that just means "derive from whatever `getSessionSecret`
 * currently has cached", which is what this composition does. */
export async function getDerivedKeys(source: SecretSource, appEnv: AppEnv): Promise<DerivedKeys> {
  const secret = await getSessionSecret(source);
  return deriveKeys(secret, appEnv);
}
