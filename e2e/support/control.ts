// docs/web.md §7 / docs/control-plane.md §5.5: wraps `POST /api/test/control` with Playwright's
// `request` fixture. That route is registered only when `APP_ENV` is `test` or `local` and is
// exempt from the session and CSRF checks, so these calls go straight to the local API on 8787
// (no cookie, no Origin/X-DST-Request headers needed).
import type { APIRequestContext } from '@playwright/test';

const CONTROL_URL = 'http://localhost:8787/api/test/control';

async function post(request: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const res = await request.post(CONTROL_URL, { data: body });
  if (!res.ok()) {
    throw new Error(
      `POST /api/test/control ${JSON.stringify(body)} failed: ${res.status()} ${await res.text()}`,
    );
  }
}

/** Restores the two seeded worlds `test-a` / `test-b`, both `stopped` (docs/web.md §7). Every
 * spec calls this before each test. */
export async function reset(request: APIRequestContext): Promise<void> {
  await post(request, { reset: true });
}

/** Patches the cluster state item. `idleDeadlineInSeconds` is a convenience the local server
 * turns into an absolute `idleDeadline` (`docs/control-plane.md` §5.5). */
export async function setState(
  request: APIRequestContext,
  state: Record<string, unknown>,
): Promise<void> {
  await post(request, { state });
}

/** Backdates `heartbeatAt` by `seconds`, so `GET /api/worlds` reports `stale: true`
 * (docs/decisions.md §16.8). */
export async function setHeartbeatAgeSeconds(
  request: APIRequestContext,
  seconds: number,
): Promise<void> {
  await post(request, { heartbeatAgeSeconds: seconds });
}

/** Configures the fake launcher's `starting -> running` delay. */
export async function setBootMs(request: APIRequestContext, ms: number): Promise<void> {
  await post(request, { bootMs: ms });
}

/** One-shot forced error for the next matching request (`docs/control-plane.md` §5.5). */
export async function failNext(
  request: APIRequestContext,
  route: string,
  status: number,
): Promise<void> {
  await post(request, { failNext: { route, status } });
}
