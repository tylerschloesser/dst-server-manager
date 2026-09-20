// docs/auth.md §6. Parameterized by `appEnv` (see session.ts's comment for why) so this is
// directly unit-testable; `index.ts` wraps it with the real `APP_ENV` to produce the pinned
// `requireUser(event, deps)` signature.
import type { AppEnv } from './constants';
import { candidateCookieStrings, extractCookieValue, sessionCookieName } from './cookies';
import { getAllowlist } from './allowlist';
import { getDerivedKeys } from './secrets';
import { verifySessionTokenImpl } from './session';
import type { AuthDeps, RequireUserResult } from './types';
import type { HttpRequest } from '../ports';

export async function requireUserImpl(
  event: HttpRequest,
  deps: AuthDeps,
  appEnv: AppEnv,
): Promise<RequireUserResult> {
  // §6.1
  const token = extractCookieValue(candidateCookieStrings(event), sessionCookieName(appEnv));
  if (token === null) return { ok: false, status: 401, code: 'unauthorized' };

  // §6.2 step 1
  const { sessionKey } = await getDerivedKeys(deps.secrets, appEnv);
  const nowSec = Math.floor(deps.nowMs() / 1000);
  const verified = verifySessionTokenImpl(token, sessionKey, nowSec, appEnv);
  if (verified === null) return { ok: false, status: 401, code: 'unauthorized' };

  // §6.2 step 2 — the revocation path.
  const users = await getAllowlist(deps.users, deps.nowMs);
  if (!Object.hasOwn(users, verified.steamId64)) {
    return { ok: false, status: 403, code: 'not_allowed' };
  }

  // §6.2 step 3
  return {
    ok: true,
    user: { steamId64: verified.steamId64, nickname: users[verified.steamId64]! },
  };
}
