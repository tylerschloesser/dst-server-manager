// docs/auth.md §3: the Steam OpenID callback verifier. `verifyCallback` is a pure function (Steam
// is reached only through the injected `fetchSteam` port), so every check in §9 is a plain unit
// test with no HTTP happening. Order matters: cheap local checks first, the network call last.
//
// The checks are numbered C0-C20 (docs/auth.md §3.1). C0 (method must be GET) is checked by the
// caller (`completeSteamLogin` in `index.ts`), which is the only place that has the HTTP method;
// C19 (allowlist) and C20 (mint the session) are also the caller's job, since this function's
// dependencies deliberately don't include the allowlist or the session key — only the state key
// needed to verify the state cookie. That split is why `CallbackResult` has no "not allowed"
// variant: whether an `ok` result is actually allowed to sign in is a decision this module never
// makes.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AppEnv } from './constants';
import {
  BASE64URL_RE,
  CALLBACK_PATH,
  CLAIMED_ID_RE,
  EXPECTED_SIGNED,
  MAX_KV_BODY_LEN,
  MAX_QUERY_LEN,
  NONCE_MAX_AGE_S,
  NONCE_MAX_SKEW_S,
  NONCE_RE,
  OPENID_NS,
  REQUIRED_SIGNED,
  STATE_MAX_AGE_S,
  STEAMID64_MIN,
  STEAM_OP_ENDPOINT,
} from './constants';
import { extractCookieValue, stateCookieName } from './cookies';

export interface VerifyCallbackDeps {
  nowMs(): number;
  fetchSteam: typeof fetch;
  /** HMAC key for the state cookie (docs/auth.md §4), already derived by the caller. */
  stateKey: Buffer;
  appEnv: AppEnv;
  /** Needed to validate `openid.return_to`'s scheme+host and `openid.realm` was never sent, so
   * this is required even though it isn't a secret. */
  publicOrigin: string;
}

export type CallbackResult =
  | { kind: 'ok'; steamId64: string }
  | { kind: 'cancelled' }
  | { kind: 'retryable'; check: string } // Steam 403/429/3xx/timeout/network
  | { kind: 'rejected'; check: string }; // everything else

type CheckAuthResult =
  { kind: 'ok' } | { kind: 'retryable'; check: string } | { kind: 'rejected'; check: string };

function rejected(check: string): CallbackResult {
  return { kind: 'rejected', check };
}

function retryable(check: string): CallbackResult {
  return { kind: 'retryable', check };
}

const REQUIRED_PARAMS = [
  'openid.op_endpoint',
  'openid.claimed_id',
  'openid.identity',
  'openid.return_to',
  'openid.response_nonce',
  'openid.assoc_handle',
  'openid.signed',
  'openid.sig',
];

/** docs/auth.md §3.2. */
async function checkAuthentication(
  deps: VerifyCallbackDeps,
  signedNames: string[],
  signedValues: Map<string, string>,
  sig: string,
): Promise<CheckAuthResult> {
  const body = new URLSearchParams();
  for (const n of signedNames) {
    body.set('openid.' + n, signedValues.get(n)!); // includes openid.signed
  }
  body.set('openid.sig', sig);
  body.set('openid.ns', OPENID_NS); // ours, not theirs — ns is not signed
  body.set('openid.mode', 'check_authentication'); // ours, replaces id_res

  let res: Response;
  try {
    res = await deps.fetchSteam(STEAM_OP_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/plain',
        referer: 'https://steamcommunity.com/', // node-steam-signin PR#5: gets past Steam's WAF
        origin: 'https://steamcommunity.com',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { kind: 'retryable', check: 'steam_status' };
  }

  if (res.status !== 200) {
    return { kind: 'retryable', check: 'steam_status' };
  }

  const text = await res.text();
  if (text.length > MAX_KV_BODY_LEN) {
    return { kind: 'rejected', check: 'kv_too_long' };
  }

  const kv: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (line === '') continue;
    const i = line.indexOf(':');
    if (i === -1) return { kind: 'rejected', check: 'kv_parse' };
    kv[line.slice(0, i)] = line.slice(i + 1);
  }

  if (kv['ns'] !== OPENID_NS || kv['is_valid'] !== 'true') {
    return { kind: 'rejected', check: 'is_valid' };
  }

  return { kind: 'ok' };
}

export async function verifyCallback(
  rawQueryString: string,
  cookies: string[],
  deps: VerifyCallbackDeps,
): Promise<CallbackResult> {
  // C1
  if (rawQueryString.length > MAX_QUERY_LEN) return rejected('query_too_long');

  // C2 — parse it ourselves; never trust a framework's collapsed query-param map.
  const all = new URLSearchParams(rawQueryString);
  const counts = new Map<string, number>();
  for (const [k] of all) {
    if (k === 'state' || k.startsWith('openid.')) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const count of counts.values()) {
    if (count > 1) return rejected('duplicate_param');
  }
  const params = new Map<string, string>();
  for (const [k, v] of all) params.set(k, v);

  // C3
  const mode = params.get('openid.mode');
  if (mode === 'cancel') return { kind: 'cancelled' };
  if (mode !== 'id_res') return rejected('mode');

  // C4
  if (params.get('openid.ns') !== OPENID_NS) return rejected('ns');

  // C5
  for (const key of REQUIRED_PARAMS) {
    const v = params.get(key);
    if (v === undefined || v === '') return rejected('missing_param');
  }

  // C6 — the actual constant, never a lookalike; no trailing slash, no http, no lookalike host.
  if (params.get('openid.op_endpoint') !== STEAM_OP_ENDPOINT) return rejected('op_endpoint');

  // C7
  const signedRaw = params.get('openid.signed')!;
  if (signedRaw !== EXPECTED_SIGNED) return rejected('signed');
  const signedNamesForRequiredCheck = signedRaw.split(',');
  for (const req of REQUIRED_SIGNED) {
    if (!signedNamesForRequiredCheck.includes(req)) return rejected('signed');
  }

  // C8
  const signedNames = signedRaw.split(',');
  for (const n of signedNames) {
    if (!params.has('openid.' + n)) return rejected('signed_missing_field');
  }

  // C9 — from here on read only `signedValues`, plus `openid.sig` and `state`.
  const signedValues = new Map<string, string>(
    signedNames.map((n) => [n, params.get('openid.' + n)!]),
  );

  // C10
  if (signedValues.get('claimed_id') !== signedValues.get('identity')) {
    return rejected('claimed_vs_identity');
  }

  // C11 — fully anchored, no `m` flag, dot escaped, no trailing slash.
  const claimedIdMatch = CLAIMED_ID_RE.exec(signedValues.get('claimed_id')!);
  if (claimedIdMatch === null) return rejected('claimed_id');
  const steamId64 = claimedIdMatch[1]!;

  // C12
  if (BigInt(steamId64) < STEAMID64_MIN) return rejected('steamid_range');

  // C13
  let returnToUrl: URL;
  try {
    returnToUrl = new URL(signedValues.get('return_to')!);
  } catch {
    return rejected('return_to_parse');
  }
  const publicOriginUrl = new URL(deps.publicOrigin);
  if (
    returnToUrl.protocol !== publicOriginUrl.protocol ||
    returnToUrl.host !== publicOriginUrl.host ||
    returnToUrl.pathname !== CALLBACK_PATH ||
    returnToUrl.username !== '' ||
    returnToUrl.password !== '' ||
    returnToUrl.hash !== ''
  ) {
    return rejected('return_to');
  }

  // C14 — subset rule (OpenID 2.0 §11.1), one-directional. Extra params in the actual request URL
  // that are absent from return_to are accepted.
  for (const [k, v] of returnToUrl.searchParams) {
    if (params.get(k) !== v) return rejected('return_to_query');
  }

  // C15
  const stateId = returnToUrl.searchParams.get('state');
  if (stateId === null || !BASE64URL_RE.test(stateId) || stateId.length !== 43) {
    return rejected('state_missing');
  }

  // C16 — state cookie, read via the same fail-closed procedure as §6.1.
  const stateCookieValue = extractCookieValue(cookies, stateCookieName(deps.appEnv));
  if (stateCookieValue === null) return rejected('state_cookie');
  const stateParts = stateCookieValue.split('.');
  if (stateParts.length !== 3) return rejected('state_cookie');
  const [cookieStateId, issuedAtRaw, cookieMac] = stateParts as [string, string, string];
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt)) return rejected('state_cookie');

  const expectedMac = createHmac('sha256', deps.stateKey)
    .update(`${cookieStateId}|${issuedAtRaw}`)
    .digest();
  const gotMac = Buffer.from(cookieMac, 'base64url');
  if (gotMac.length !== expectedMac.length || !timingSafeEqual(gotMac, expectedMac)) {
    return rejected('state_mac');
  }

  const cookieIdBuf = Buffer.from(cookieStateId, 'utf8');
  const queryIdBuf = Buffer.from(stateId, 'utf8');
  if (cookieIdBuf.length !== queryIdBuf.length || !timingSafeEqual(cookieIdBuf, queryIdBuf)) {
    return rejected('state_mismatch');
  }

  const now = Math.floor(deps.nowMs() / 1000);
  if (now - issuedAt > STATE_MAX_AGE_S || issuedAt - now > NONCE_MAX_SKEW_S) {
    return rejected('state_expired');
  }

  // C17 — nonce freshness (replay defence).
  const nonceMatch = NONCE_RE.exec(signedValues.get('response_nonce')!);
  if (nonceMatch === null) return rejected('nonce_format');
  const t = Math.floor(Date.parse(nonceMatch[1]!) / 1000);
  if (!Number.isFinite(t)) return rejected('nonce_format');
  if (now - t > NONCE_MAX_AGE_S || t - now > NONCE_MAX_SKEW_S) return rejected('nonce_window');

  // C18 — the network call, last.
  const authResult = await checkAuthentication(
    deps,
    signedNames,
    signedValues,
    params.get('openid.sig')!,
  );
  if (authResult.kind === 'retryable') return retryable(authResult.check);
  if (authResult.kind === 'rejected') return rejected(authResult.check);

  return { kind: 'ok', steamId64 };
}
