// Shared Vitest setup, referenced via `setupFiles` from the root vitest.config.ts and every
// package's vitest.config.ts (docs/testing.md §1bis). Everything local must be credential-free:
// if a unit test can reach AWS or the network, it is a bug.

// Set before any import that might read them.
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.AWS_SDK_LOAD_CONFIG = '0';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
process.env.AWS_CONFIG_FILE = '/dev/null';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'blocked-in-unit-tests';
process.env.AWS_SECRET_ACCESS_KEY = 'blocked-in-unit-tests';
delete process.env.AWS_PROFILE;

import { vi } from 'vitest';

export const NETWORK_BLOCKED_MESSAGE = 'network access is blocked in unit tests';

function blocked(): never {
  throw new Error(NETWORK_BLOCKED_MESSAGE);
}

vi.stubGlobal(
  'fetch',
  vi.fn(() => blocked()),
);

class BlockedWebSocket {
  constructor() {
    blocked();
  }
}
vi.stubGlobal('WebSocket', BlockedWebSocket);

// The `default` export, not the namespace object: for a Node builtin the namespace is a frozen
// ESM record whose properties are non-configurable, so `vi.spyOn` throws `Cannot redefine
// property`. The default export is the mutable CommonJS `module.exports` mirror, which is what
// both `import http from 'node:http'` and `require('node:http')` hand to application code.
const http = (await import('node:http')).default;
const https = (await import('node:https')).default;

for (const mod of [http, https]) {
  vi.spyOn(mod, 'request').mockImplementation(() => blocked());
  vi.spyOn(mod, 'get').mockImplementation(() => blocked());
}

// undici backs Node's global fetch/Agent; stub it too so an SDK that reaches for it directly
// still gets the same guard message instead of a real socket attempt.
try {
  // The specifier is deliberately NOT a literal. `undici` is not a dependency of this repo and
  // must not become one: Node 22 bundles it internally, and this block is a belt-and-braces stub
  // whose absence is already handled by the `catch` below. With a literal specifier `tsc`
  // resolves the module at typecheck time and fails with TS2307 wherever the package is absent —
  // which is every clean `--frozen-lockfile` install, including CI. It only ever passed locally
  // because Node and tsc walk up past the repo and found a stray `~/node_modules/undici` in the
  // developer's home directory (measured; that is also why `pnpm check` was green while the
  // first CI run was red). A computed specifier keeps the runtime behaviour identical and leaves
  // nothing for tsc to resolve.
  const undiciSpecifier = 'undici';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const undici: any = await import(undiciSpecifier);
  if (undici?.Agent?.prototype?.dispatch) {
    vi.spyOn(undici.Agent.prototype, 'dispatch').mockImplementation(() => blocked());
  }
} catch {
  // undici is not resolvable as a standalone package in this environment; the global fetch and
  // node:http(s) stubs above already cover every code path that could reach the network.
}
