// Shared types for the auth module, split out from `index.ts` so sibling modules (requireUser.ts,
// steamOpenId.ts via its own local types, etc.) can import them without a circular dependency on
// `index.ts` itself. `index.ts` re-exports every one of these under the same names, so nothing
// outside this directory needs to know they live here.
import type { AllowlistSource } from './allowlist';
import type { SecretSource } from './secrets';

export type User = { steamId64: string; nickname: string };

export interface AuthResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
}

export interface AuthDeps {
  secrets: SecretSource;
  users: AllowlistSource;
  nowMs(): number;
  fetchSteam: typeof fetch;
}

/** docs/auth.md §12.3: an allowlisted member, or the holder of a guest (read-only) link. Defined
 * once, on the Identity port. */
export type { Viewer } from '../ports';
import type { Viewer } from '../ports';

export type AuthFailure =
  | { ok: false; status: 401; code: 'unauthorized' }
  | { ok: false; status: 403; code: 'not_allowed' };

export type RequireUserResult =
  { ok: true; user: User } | AuthFailure | { ok: false; status: 403; code: 'read_only' };

export type RequireViewerResult = { ok: true; viewer: Viewer } | AuthFailure;
