// Local dev server (docs/control-plane.md §5.5, decisions §16.1, §16.25). `node:http` on port
// 8787, converting `IncomingMessage` into the same payload-v2 shape `handlers/api.ts` gets from
// CloudFront and calling the same router — exactly one code path. Started with `APP_ENV=local` by
// `pnpm dev` and with `APP_ENV=test` by Playwright. Two routes exist only here
// (`DST_LOCAL_ONLY`, decisions §16.4): the Lambda entrypoints never import this file, so no
// bundler can pull them into `dist/lambda/`.
import { hkdfSync, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { LOCAL_ONLY_MARKER, initialClusterState } from '@dst/shared';
import type { ClusterStateItem } from '@dst/shared';

// docs/decisions.md §16.37: the only place `@dst/api/test-secret` is imported outside `e2e/` and
// tests. `src/auth/index.ts` never re-exports it.
import { TEST_SESSION_SECRET } from '@dst/api/test-secret';

import { createAuthIdentity } from './adapters/auth-identity';
import { systemClock } from './adapters/system-clock';
import type { AllowlistSource, AuthDeps, SecretSource } from './auth';
import { mintSessionToken } from './auth';
import { FakeParameterStore } from './fakes/fake-parameter-store';
import { FakeStateStore } from './fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from './fakes/fake-world-registry';
import { DEFAULT_LOCAL_LAUNCHER_OPTIONS, LocalFakeLauncher } from './local/localLauncher';
import type { LocalLauncherOptions } from './local/localLauncher';
import type { HttpRequest, HttpResponse } from './ports';
import { createRouter } from './router';

const PORT = 8787;

const APP_ENV = process.env['APP_ENV'] ?? '';
if (APP_ENV !== 'local' && APP_ENV !== 'test') {
  throw new Error(
    `${LOCAL_ONLY_MARKER}: src/local.ts must run with APP_ENV=local or APP_ENV=test, got ${JSON.stringify(APP_ENV)}`,
  );
}

const PUBLIC_ORIGIN = process.env['PUBLIC_ORIGIN'] ?? 'http://localhost:5173';

// ---------------------------------------------------------------------------------------------
// Wiring (docs/control-plane.md §5.5): fakes shared with the unit tests, seeded exactly as spec'd.
// ---------------------------------------------------------------------------------------------

const store = new FakeStateStore();
const registry = new FakeWorldRegistry();

/** decisions §16.25: the local fake registry seeds exactly `test-a` and `test-b`. */
function seedWorlds(): void {
  registry.clear();
  registry.add(
    testWorld({
      worldId: 'test-a',
      displayName: 'World A',
      serverName: 'DST World A',
      idleMinutes: 30,
    }),
  );
  registry.add(
    testWorld({
      worldId: 'test-b',
      displayName: 'World B',
      serverName: 'DST World B',
      hasCaves: false,
      idleMinutes: 30,
    }),
  );
}
seedWorlds();

const params = new FakeParameterStore({ '/dst/cluster-password': 'localpass1' });

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envPlayers(): number[] {
  const raw = process.env['DST_LOCAL_PLAYERS'];
  if (raw === undefined || raw === '') return DEFAULT_LOCAL_LAUNCHER_OPTIONS.players;
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

const launcher = new LocalFakeLauncher(store, registry, {
  bootSeconds: envInt('DST_LOCAL_BOOT_SECONDS', DEFAULT_LOCAL_LAUNCHER_OPTIONS.bootSeconds),
  stopSeconds: envInt('DST_LOCAL_STOP_SECONDS', DEFAULT_LOCAL_LAUNCHER_OPTIONS.stopSeconds),
  idleMinutesOverride: envInt('DST_LOCAL_IDLE_MINUTES', 0),
  players: envPlayers(),
  launchFail: process.env['DST_LOCAL_LAUNCH_FAIL'] !== undefined,
  stale: process.env['DST_LOCAL_STALE'] !== undefined,
});
launcher.start();

// docs/auth.md §4: `local.ts` wires the test `SecretSource` — the only place
// `@dst/api/test-secret` is imported outside `e2e/` and tests (decisions §16.37).
const secretSource: SecretSource = {
  async read(): Promise<string> {
    return process.env['DEV_SESSION_SECRET'] ?? TEST_SESSION_SECRET;
  },
};

const allowlistSource: AllowlistSource = {
  async getUsers(): Promise<Record<string, string>> {
    return {};
  },
};

const authDeps: AuthDeps = {
  secrets: secretSource,
  users: allowlistSource,
  nowMs: () => Date.now(),
  fetchSteam: fetch,
};

const router = createRouter({
  clock: systemClock,
  store,
  registry,
  params,
  launcher,
  identity: createAuthIdentity(authDeps),
  auth: authDeps,
  publicOrigin: PUBLIC_ORIGIN,
});

// ---------------------------------------------------------------------------------------------
// IncomingMessage <-> payload-v2 conversion (docs/control-plane.md §5.5): exactly one code path.
// ---------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

async function toEvent(req: IncomingMessage): Promise<HttpRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const bodyBuf = await readBody(req);
  const headers = toHeaders(req.headers);
  const cookieHeader = headers['cookie'];
  const cookies = cookieHeader !== undefined ? cookieHeader.split(';').map((s) => s.trim()) : [];

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith('?') ? url.search.slice(1) : '',
    cookies,
    headers,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'local',
      http: {
        method: req.method ?? 'GET',
        path: url.pathname,
        protocol: 'HTTP/1.1',
        // Never used by the router (which reads x-forwarded-for); there is no real viewer here.
        sourceIp: '127.0.0.1',
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: bodyBuf.length > 0 ? bodyBuf.toString('utf8') : undefined,
    isBase64Encoded: false,
  };
}

function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const headers: http.OutgoingHttpHeaders = { ...response.headers };
  if (response.cookies.length > 0) {
    headers['set-cookie'] = response.cookies;
  }
  res.writeHead(response.status, headers);
  res.end(response.body ?? '');
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  respondJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
}

// ---------------------------------------------------------------------------------------------
// Local-only routes (decisions §16.4, docs/control-plane.md §5.5). Never imported by
// `handlers/api.ts` or `handlers/reaper.ts`, so no bundler can pull them into `dist/lambda/`.
// ---------------------------------------------------------------------------------------------

const DEV_USER_STEAMID64 = '76561190000000001'; // fake, not a real SteamID64

/** GET /api/dev/login, `APP_ENV=local` only (${LOCAL_ONLY_MARKER}). */
async function handleDevLogin(res: ServerResponse): Promise<void> {
  try {
    const secret = await secretSource.read();
    const ikm = Buffer.from(secret, 'utf8');
    const salt = Buffer.from('dst-v1', 'utf8');
    const sessionKey = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from(`${APP_ENV}:session`, 'utf8'), 32),
    );
    const token = mintSessionToken({
      steamId64: DEV_USER_STEAMID64,
      sessionKey,
      nowSec: Math.floor(Date.now() / 1000),
    });
    res.writeHead(302, {
      location: '/',
      'set-cookie': `dst_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end();
  } catch (err) {
    // Expected until T2.2 replaces src/auth/index.ts's bodies.
    res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dev login not available yet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyStatePatch(patch: Record<string, unknown>): void {
  const base = store.peek() ?? initialClusterState();
  const next: ClusterStateItem = { ...base, ...(patch as Partial<ClusterStateItem>) };
  const idleDeadlineInSeconds = patch['idleDeadlineInSeconds'];
  if (typeof idleDeadlineInSeconds === 'number') {
    next.idleDeadline = new Date(Date.now() + idleDeadlineInSeconds * 1000).toISOString();
  }
  store.setRaw(next);
}

/** POST /api/test/control, `APP_ENV` `test` or `local` (${LOCAL_ONLY_MARKER}); exempt from the
 * session and CSRF checks (docs/control-plane.md §5.5). */
async function handleTestControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyBuf = await readBody(req);
  let payload: unknown;
  try {
    payload = bodyBuf.length > 0 ? JSON.parse(bodyBuf.toString('utf8')) : {};
  } catch {
    respondJson(res, 400, { error: { code: 'invalid_body', message: 'Body is not valid JSON' } });
    return;
  }
  if (typeof payload !== 'object' || payload === null) {
    respondJson(res, 400, {
      error: { code: 'invalid_body', message: 'Body must be a JSON object' },
    });
    return;
  }
  const body = payload as Record<string, unknown>;

  if (body['reset'] === true) {
    store.setRaw(undefined);
    seedWorlds();
  }
  if (typeof body['state'] === 'object' && body['state'] !== null) {
    applyStatePatch(body['state'] as Record<string, unknown>);
  }
  if (typeof body['heartbeatAgeSeconds'] === 'number') {
    const current = store.peek();
    if (current !== undefined) {
      store.setRaw({
        ...current,
        heartbeatAt: new Date(Date.now() - body['heartbeatAgeSeconds'] * 1000).toISOString(),
      });
    }
  }
  if (typeof body['bootMs'] === 'number') {
    const opts: Partial<LocalLauncherOptions> = { bootSeconds: body['bootMs'] / 1000 };
    launcher.configure(opts);
  }
  // `failNext` (a one-shot forced error) is out of scope for T2.1's minimal test-control surface;
  // reset/state/heartbeatAgeSeconds/bootMs above cover every state the UI can be in.

  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/dev/login') {
      if (APP_ENV !== 'local') {
        notFound(res);
        return;
      }
      await handleDevLogin(res);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/test/control') {
      if (APP_ENV !== 'test' && APP_ENV !== 'local') {
        notFound(res);
        return;
      }
      await handleTestControl(req, res);
      return;
    }

    const event = await toEvent(req);
    const response = await router.handle(event);
    writeResponse(res, response);
  } catch (err) {
    console.error(JSON.stringify({ event: 'local_server_error', err: String(err) }));
    respondJson(res, 500, { error: { code: 'internal', message: 'Internal error' } });
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      event: 'local_server_listening',
      port: PORT,
      appEnv: APP_ENV,
      publicOrigin: PUBLIC_ORIGIN,
    }),
  );
});

server.on('close', () => {
  launcher.dispose();
});
