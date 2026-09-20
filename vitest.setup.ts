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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const undici: any = await import('undici');
  if (undici?.Agent?.prototype?.dispatch) {
    vi.spyOn(undici.Agent.prototype, 'dispatch').mockImplementation(() => blocked());
  }
} catch {
  // undici is not resolvable as a standalone package in this environment; the global fetch and
  // node:http(s) stubs above already cover every code path that could reach the network.
}
