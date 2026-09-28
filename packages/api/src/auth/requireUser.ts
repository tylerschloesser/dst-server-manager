// docs/auth.md §6, §12. Parameterized by `appEnv` (see session.ts's comment for why) so this is
// directly unit-testable; `index.ts` wraps it with the real `APP_ENV` to produce the pinned
// `requireUser(event, deps)` / `requireViewer(event, deps)` signatures.
import type { AppEnv } from './constants';
import { candidateCookieStrings, extractCookieValue, sessionCookieName } from './cookies';
import { getAllowlist } from './allowlist';
import { getDerivedKeys } from './secrets';
import { verifyGuestTokenImpl, verifySessionTokenImpl } from './session';
import type { AuthDeps, RequireUserResult, RequireViewerResult } from './types';
import type { HttpRequest } from '../ports';

/** docs/auth.md §12.3: who is looking — an allowlisted member, or the holder of a guest link. A
 * cookie starting `g1.` is only ever verified as a guest token; anything else takes the §6 member
 * path, allowlist included. */
export async function requireViewerImpl(
  event: HttpRequest,
  deps: AuthDeps,
  appEnv: AppEnv,
): Promise<RequireViewerResult> {
  // §6.1
  const token = extractCookieValue(candidateCookieStrings(event), sessionCookieName(appEnv));
  if (token === null) return { ok: false, status: 401, code: 'unauthorized' };

  const { sessionKey, guestKey } = await getDerivedKeys(deps.secrets, appEnv);
  const nowSec = Math.floor(deps.nowMs() / 1000);

  // §12.3 — a guest link: no allowlist, no SteamID64.
  if (token.startsWith('g1.')) {
    const guest = verifyGuestTokenImpl(token, guestKey, nowSec, appEnv);
    if (guest === null) return { ok: false, status: 401, code: 'unauthorized' };
    return { ok: true, viewer: { kind: 'guest', label: guest.label } };
  }

  // §6.2 step 1
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
    viewer: {
      kind: 'member',
      steamId64: verified.steamId64,
      nickname: users[verified.steamId64]!,
    },
  };
}

/** docs/auth.md §6: a member, or nothing. A valid guest link gets 403 `read_only` rather than 401,
 * so a guest who reaches a write sees why instead of looking signed out (§12.3). */
export async function requireUserImpl(
  event: HttpRequest,
  deps: AuthDeps,
  appEnv: AppEnv,
): Promise<RequireUserResult> {
  const result = await requireViewerImpl(event, deps, appEnv);
  if (!result.ok) return result;
  if (result.viewer.kind === 'guest') return { ok: false, status: 403, code: 'read_only' };
  return {
    ok: true,
    user: { steamId64: result.viewer.steamId64, nickname: result.viewer.nickname },
  };
}
