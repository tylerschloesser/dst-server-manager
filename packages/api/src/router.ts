// The Function URL v2 router (docs/control-plane.md §5.2). No framework: a table of
// `{ method, pattern, handler }`. Every route of docs/decisions.md §10 is registered here,
// including the five auth routes, which delegate straight to `src/auth/index.ts`. `handlers/api.ts`
// and `local.ts` are the only two callers — the Lambda entry hands it a real
// `APIGatewayProxyEventV2`, `local.ts` hands it an equivalent value it built from `IncomingMessage`
// — so there is exactly one code path in prod and local dev (docs/control-plane.md §5.5).
import { isValidWorldId } from '@dst/shared';
import type { MeResponse } from '@dst/shared';

import * as auth from './auth';
import type { AuthDeps } from './auth';
import { ApiError, errorBody } from './errors';
import type { ErrorCode } from './errors';
import type { HttpRequest, HttpResponse, Identity } from './ports';
import { buildWorldsResponse, startWorld, stopWorld } from './routes/worlds';
import type { WorldsDeps } from './routes/worlds';

export interface RouterDeps extends WorldsDeps {
  identity: Identity;
  auth: AuthDeps;
  /** e.g. `https://dst.ty.ler.dev`, or `http://localhost:5173` locally (decisions §16.25). Used
   * only for the CSRF `Origin` check and never derived from a request header
   * (docs/decisions.md §9). */
  publicOrigin: string;
}

type RouteHandler = (
  event: HttpRequest,
  deps: RouterDeps,
  params: string[],
) => Promise<HttpResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  csrf: boolean;
  handler: RouteHandler;
}

const WORLD_ID_CAPTURE = '([^/]+)';

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    cookies: [],
    body: JSON.stringify(body),
  };
}

function errorResponse(code: ErrorCode, message?: string): HttpResponse {
  const status = new ApiError(code, message).status;
  return jsonResponse(status, errorBody(code, message));
}

/** docs/control-plane.md §5.2: every response, including the auth module's redirects, carries
 * these two headers. Fills them in only if the handler did not already set them. */
function finalize(response: HttpResponse): HttpResponse {
  return {
    ...response,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...response.headers,
    },
  };
}

/** docs/spikes/cloudfront-oac-lambda-url.md: the real viewer IP is `x-forwarded-for`;
 * `requestContext.http.sourceIp` is CloudFront's own IP and must never be used. */
export function viewerIp(event: HttpRequest): string | null {
  const xff = event.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || xff.length === 0) return null;
  const first = xff.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

function csrfOk(event: HttpRequest, publicOrigin: string): boolean {
  return event.headers['origin'] === publicOrigin && event.headers['x-dst-request'] === '1';
}

// -------------------------------------------------------------------------------------------
// Route handlers
// -------------------------------------------------------------------------------------------

async function handleListWorlds(event: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  await deps.identity.requireUser(event);
  const body = await buildWorldsResponse(deps);
  return jsonResponse(200, body);
}

async function handleStart(
  event: HttpRequest,
  deps: RouterDeps,
  params: string[],
): Promise<HttpResponse> {
  const worldId = params[0] ?? '';
  if (!isValidWorldId(worldId)) throw new ApiError('invalid_world_id');
  const user = await deps.identity.requireUser(event);
  const world = await deps.registry.get(worldId);
  if (world === null) throw new ApiError('world_not_found');

  const result = await startWorld(deps, worldId, user);
  if (result.kind === 'error') return errorResponse(result.code, result.message);
  return jsonResponse(200, result.body);
}

async function handleStop(
  event: HttpRequest,
  deps: RouterDeps,
  params: string[],
): Promise<HttpResponse> {
  const worldId = params[0] ?? '';
  if (!isValidWorldId(worldId)) throw new ApiError('invalid_world_id');
  const user = await deps.identity.requireUser(event);
  const world = await deps.registry.get(worldId);
  if (world === null) throw new ApiError('world_not_found');

  const result = await stopWorld(deps, worldId, user);
  if (result.kind === 'error') return errorResponse(result.code, result.message);
  return jsonResponse(200, result.body);
}

/** GET /api/me — delegates directly to the auth module's `requireUser` (docs/decisions.md §10). */
async function handleMe(event: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  const result = await auth.requireUser(event, deps.auth);
  if (!result.ok) return errorResponse(result.code);
  const body: MeResponse = { nickname: result.user.nickname };
  return jsonResponse(200, body);
}

async function handleAuthLogin(event: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  void event;
  const res = await auth.beginSteamLogin(deps.auth);
  return res;
}

async function handleAuthCallback(event: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  const res = await auth.completeSteamLogin(event, deps.auth);
  return res;
}

async function handleAuthLogout(event: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  void event;
  return auth.logout(deps.auth);
}

// -------------------------------------------------------------------------------------------
// Routing table (docs/decisions.md §10, docs/control-plane.md §5.2)
// -------------------------------------------------------------------------------------------

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/api\/auth\/steam\/login$/, csrf: false, handler: handleAuthLogin },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/steam\/callback$/,
    csrf: false,
    handler: handleAuthCallback,
  },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, csrf: true, handler: handleAuthLogout },
  { method: 'GET', pattern: /^\/api\/me$/, csrf: false, handler: handleMe },
  { method: 'GET', pattern: /^\/api\/worlds$/, csrf: false, handler: handleListWorlds },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/worlds/${WORLD_ID_CAPTURE}/start$`),
    csrf: true,
    handler: handleStart,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/worlds/${WORLD_ID_CAPTURE}/stop$`),
    csrf: true,
    handler: handleStop,
  },
];

type MatchResult = { route: Route; params: string[] } | 'not_found' | 'method_not_allowed';

function matchRoute(path: string, method: string): MatchResult {
  let pathMatched = false;
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (m === null) continue;
    pathMatched = true;
    if (route.method === method) {
      return { route, params: m.slice(1) };
    }
  }
  return pathMatched ? 'method_not_allowed' : 'not_found';
}

export interface Router {
  handle(event: HttpRequest): Promise<HttpResponse>;
}

export function createRouter(deps: RouterDeps): Router {
  return {
    async handle(event: HttpRequest): Promise<HttpResponse> {
      try {
        const method = event.requestContext.http.method;
        const path = event.rawPath;
        console.log(JSON.stringify({ event: 'request', method, path, viewerIp: viewerIp(event) }));

        const found = matchRoute(path, method);
        if (found === 'not_found') return finalize(errorResponse('not_found'));
        if (found === 'method_not_allowed') return finalize(errorResponse('method_not_allowed'));

        const { route, params } = found;
        if (route.csrf && !csrfOk(event, deps.publicOrigin)) {
          return finalize(errorResponse('csrf_failed'));
        }

        return finalize(await route.handler(event, deps, params));
      } catch (err) {
        if (err instanceof ApiError) {
          return finalize(errorResponse(err.code, err.message));
        }
        const name = err instanceof Error ? err.name : 'Error';
        const message = err instanceof Error ? err.message : String(err);
        console.log(JSON.stringify({ event: 'unhandled', name, message }));
        return finalize(errorResponse('internal'));
      }
    },
  };
}
