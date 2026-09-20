// docs/auth.md §0: names, regexes and thresholds owned by the auth module. Pure data, no
// side effects, safe to import from anywhere (including tests) without triggering any
// module-load assertion.

/** The env discriminator (docs/decisions.md §16.1, docs/auth.md §0). The string inside a session
 * token is exactly one of these three values. */
export type AppEnv = 'prod' | 'test' | 'local';

export const OPENID_NS = 'http://specs.openid.net/auth/2.0';
/** Hardcoded, never taken from request input. The `check_authentication` POST always goes here,
 * never to the request's own `openid.op_endpoint` value. */
export const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';
export const EXPECTED_SIGNED =
  'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
export const REQUIRED_SIGNED = [
  'op_endpoint',
  'claimed_id',
  'identity',
  'return_to',
  'response_nonce',
  'assoc_handle',
] as const;
export const CALLBACK_PATH = '/api/auth/steam/callback';
export const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119[0-9]{10})$/;
export const NONCE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
export const STEAMID64_RE = /^7656119[0-9]{10}$/;
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
export const STEAMID64_MIN = 76561197960265729n; // individual-account base
export const NONCE_MAX_AGE_S = 300;
export const NONCE_MAX_SKEW_S = 60;
export const STATE_MAX_AGE_S = 600;
export const SESSION_MAX_AGE_S = 2_592_000; // 30 days
export const MAX_QUERY_LEN = 4096;
export const MAX_KV_BODY_LEN = 4096;
export const MAX_TOKEN_LEN = 1024;
export const SECRET_TTL_MS = 300_000; // 5 min
export const ALLOWLIST_TTL_MS = 60_000; // 60 s
