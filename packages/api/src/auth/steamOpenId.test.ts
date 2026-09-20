// docs/auth.md §9.2 — numbered cases 1-63, covering the ordered verifier algorithm (§3.1) directly
// against `verifyCallback`. No HTTP happens: `fetchSteam` is injected (§9.1).
import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CALLBACK_PATH,
  CLAIMED_ID_RE,
  EXPECTED_SIGNED,
  OPENID_NS,
  STEAM_OP_ENDPOINT,
} from './constants';
import { verifyCallback } from './steamOpenId';
import type { VerifyCallbackDeps } from './steamOpenId';

const FAKE_STEAM_ID = '76561199000000001';
const PUBLIC_ORIGIN = 'https://dst.ty.ler.dev';
const NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');
const STATE_ID = randomBytes(32).toString('base64url');
const STATE_ISSUED_AT = Math.floor(NOW_MS / 1000) - 5; // 5s old, well within the 600s window

function isoPrefix(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

type Pair = [string, string];

function defaultPairs(): Pair[] {
  const identity = `https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}`;
  const returnTo = `${PUBLIC_ORIGIN}${CALLBACK_PATH}?state=${STATE_ID}`;
  const nonce = `${isoPrefix(NOW_MS - 5000)}r4nd0m`;
  return [
    ['openid.ns', OPENID_NS],
    ['openid.mode', 'id_res'],
    ['openid.op_endpoint', STEAM_OP_ENDPOINT],
    ['openid.claimed_id', identity],
    ['openid.identity', identity],
    ['openid.return_to', returnTo],
    ['openid.response_nonce', nonce],
    ['openid.assoc_handle', 'fake-assoc-handle'],
    ['openid.signed', EXPECTED_SIGNED],
    ['openid.sig', 'ZmFrZS1zaWc='],
    ['state', STATE_ID],
  ];
}

function toQueryString(pairs: Pair[]): string {
  const usp = new URLSearchParams();
  for (const [k, v] of pairs) usp.append(k, v);
  return usp.toString();
}

function setValue(pairs: Pair[], key: string, value: string): Pair[] {
  let found = false;
  const next = pairs.map(([k, v]): Pair => {
    if (k === key) {
      found = true;
      return [k, value];
    }
    return [k, v];
  });
  if (!found) next.push([key, value]);
  return next;
}

function removeKey(pairs: Pair[], key: string): Pair[] {
  return pairs.filter(([k]) => k !== key);
}

function appendPair(pairs: Pair[], key: string, value: string): Pair[] {
  return [...pairs, [key, value]];
}

function stateKeyBytes(): Buffer {
  return Buffer.from('unit-test-state-key-000000000000', 'utf8').subarray(0, 32);
}

function stateCookieValue(stateId: string, issuedAt: number, key: Buffer): string {
  const mac = createHmac('sha256', key).update(`${stateId}|${issuedAt}`).digest('base64url');
  return `${stateId}.${issuedAt}.${mac}`;
}

/**
 * Flips a bit in the *first* byte of a base64url-encoded value and re-encodes it, guaranteeing a
 * genuinely different decoded byte sequence.
 *
 * A 32-byte MAC encodes to 43 base64url characters; 43 chars carry 258 bits, so the final
 * character contributes only 4 significant bits and its low 2 bits are discarded on decode. That
 * means naively mutating the *last* character of a base64url string (e.g. swapping 'A' for 'B')
 * can land on an alias that decodes to the identical bytes, silently testing nothing. The first
 * byte has no such truncation, so flipping a bit there always changes both the encoded string and
 * the decoded bytes.
 */
function corruptBase64url(value: string): string {
  const buf = Buffer.from(value, 'base64url');
  buf[0] = buf[0]! ^ 0x01;
  return buf.toString('base64url');
}

function validStateCookie(key: Buffer = stateKeyBytes()): string[] {
  return [`dst_oidc_state=${stateCookieValue(STATE_ID, STATE_ISSUED_AT, key)}`];
}

function makeDeps(overrides: Partial<VerifyCallbackDeps> = {}): VerifyCallbackDeps {
  return {
    nowMs: () => NOW_MS,
    fetchSteam: vi.fn(
      async () => new Response('ns:' + OPENID_NS + '\nis_valid:true\n', { status: 200 }),
    ),
    stateKey: stateKeyBytes(),
    appEnv: 'test',
    publicOrigin: PUBLIC_ORIGIN,
    ...overrides,
  };
}

async function run(
  pairs: Pair[],
  deps: Partial<VerifyCallbackDeps> = {},
  cookies = validStateCookie(),
) {
  return verifyCallback(toQueryString(pairs), cookies, makeDeps(deps));
}

describe('Happy path', () => {
  it('1. valid assertion -> ok with the fake SteamID', async () => {
    const result = await run(defaultPairs());
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
  });

  it('2. claimed_id over http:// instead of https:// -> still ok', async () => {
    const identity = `http://steamcommunity.com/openid/id/${FAKE_STEAM_ID}`;
    let pairs = setValue(defaultPairs(), 'openid.claimed_id', identity);
    pairs = setValue(pairs, 'openid.identity', identity);
    const result = await run(pairs);
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
  });

  it('3. captured check_authentication request has the right URL, method and body', async () => {
    const fetchSteam = vi.fn<typeof fetch>();
    fetchSteam.mockImplementation(
      async () => new Response('ns:' + OPENID_NS + '\nis_valid:true\n', { status: 200 }),
    );
    await run(defaultPairs(), { fetchSteam });
    expect(fetchSteam).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSteam.mock.calls[0]!;
    expect(url).toBe('https://steamcommunity.com/openid/login');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(
      await new Response(init?.body as ConstructorParameters<typeof Response>[0]).text(),
    );
    expect(body.get('openid.mode')).toBe('check_authentication');
    expect(body.get('openid.ns')).toBe(OPENID_NS);
    for (const name of EXPECTED_SIGNED.split(',')) {
      expect(body.get('openid.' + name)).toBe(
        new Map(defaultPairs()).get('openid.' + name) ?? EXPECTED_SIGNED,
      );
    }
  });

  it('4. captured request has redirect manual, a 5s AbortSignal and the steamcommunity.com headers', async () => {
    const fetchSteam = vi.fn<typeof fetch>();
    fetchSteam.mockImplementation(
      async () => new Response('ns:' + OPENID_NS + '\nis_valid:true\n', { status: 200 }),
    );
    await run(defaultPairs(), { fetchSteam });
    const [, init] = fetchSteam.mock.calls[0]!;
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = init?.headers as Record<string, string>;
    expect(headers['referer']).toBe('https://steamcommunity.com/');
    expect(headers['origin']).toBe('https://steamcommunity.com');
  });
});

describe('Forged provider', () => {
  it('5. op_endpoint = evil.example -> rejected, fetchSteam never called', async () => {
    const fetchSteam = vi.fn();
    const pairs = setValue(
      defaultPairs(),
      'openid.op_endpoint',
      'https://evil.example/openid/login',
    );
    const result = await run(pairs, { fetchSteam });
    expect(result.kind).toBe('rejected');
    expect(fetchSteam).not.toHaveBeenCalled();
  });

  it('6. op_endpoint with a trailing slash -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.op_endpoint', STEAM_OP_ENDPOINT + '/');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('7. op_endpoint host suffix lookalike -> rejected', async () => {
    const pairs = setValue(
      defaultPairs(),
      'openid.op_endpoint',
      'https://steamcommunity.com.evil.example/openid/login',
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('8. op_endpoint over http:// -> rejected', async () => {
    const pairs = setValue(
      defaultPairs(),
      'openid.op_endpoint',
      'http://steamcommunity.com/openid/login',
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it("9. valid Steam response for a non-allowlisted id -> ok, allowlist rejection is the caller's job", async () => {
    // verifyCallback itself has no allowlist dependency (C19 is the caller's job); it still
    // returns `ok` here. The end-to-end "no session cookie" behaviour is covered at the
    // completeSteamLogin level in requireUser.test.ts (`Session / allowlist` group, case 68).
    const fetchSteam = vi.fn<typeof fetch>();
    fetchSteam.mockImplementation(
      async () => new Response('ns:' + OPENID_NS + '\nis_valid:true\n', { status: 200 }),
    );
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
    expect(fetchSteam).toHaveBeenCalledTimes(1);
  });
});

describe('Loose claimed_id', () => {
  const cases: Array<[string, string]> = [
    [
      '10. domain suffix after the id',
      `https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}.evil.com/`,
    ],
    ['11. trailing slash', `https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}/`],
    [
      '12. open-redirect-shaped host',
      `https://evil.com/?u=https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}`,
    ],
    [
      '13. escaped dot must not become a wildcard',
      `https://steamcommunityXcom/openid/id/${FAKE_STEAM_ID}`,
    ],
    [
      '14. trailing newline, anchored, no m flag',
      `https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}\n`,
    ],
    ['15. too short to be a real SteamID64', 'https://steamcommunity.com/openid/id/123'],
    [
      '16. below the individual-account base',
      'https://steamcommunity.com/openid/id/00000000000000000',
    ],
  ];

  it.each(cases)('%s -> rejected', async (_title, claimedId) => {
    const pairs = setValue(defaultPairs(), 'openid.claimed_id', claimedId);
    const withIdentity = setValue(pairs, 'openid.identity', claimedId);
    const result = await run(withIdentity);
    expect(result.kind).toBe('rejected');
  });

  it('17. claimed_id !== identity -> rejected', async () => {
    const pairs = setValue(
      defaultPairs(),
      'openid.identity',
      `https://steamcommunity.com/openid/id/76561199000000002`,
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  // Defect 4 (docs/_security-review.md): C12 (the STEAMID64_MIN range check) had no case that
  // reaches it — case 16 above is already rejected one line earlier, by C11's regex, because an
  // all-zero id doesn't match `7656119[0-9]{10}` at all. This id *does* match the regex (proving
  // it reaches C12) but its numeric value is below the individual-account base, so only the range
  // check can reject it.
  it('C12. below STEAMID64_MIN but matches CLAIMED_ID_RE -> rejected by the range check', async () => {
    const belowMin = 'https://steamcommunity.com/openid/id/76561190000000001';
    expect(CLAIMED_ID_RE.test(belowMin)).toBe(true); // sanity: this reaches C12, not C11
    const pairs = setValue(defaultPairs(), 'openid.claimed_id', belowMin);
    const withIdentity = setValue(pairs, 'openid.identity', belowMin);
    const result = await run(withIdentity);
    expect(result.kind).toBe('rejected');
  });
});

describe('Signed-field tampering', () => {
  it('18. signed omits claimed_id -> rejected, fetchSteam never called', async () => {
    const fetchSteam = vi.fn();
    const pairs = setValue(
      defaultPairs(),
      'openid.signed',
      'signed,op_endpoint,identity,return_to,response_nonce,assoc_handle',
    );
    const result = await run(pairs, { fetchSteam });
    expect(result.kind).toBe('rejected');
    expect(fetchSteam).not.toHaveBeenCalled();
  });

  it('19. signed omits return_to -> rejected', async () => {
    const pairs = setValue(
      defaultPairs(),
      'openid.signed',
      'signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle',
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('20. signed omits response_nonce -> rejected', async () => {
    const pairs = setValue(
      defaultPairs(),
      'openid.signed',
      'signed,op_endpoint,claimed_id,identity,return_to,assoc_handle',
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('21. signed names a field absent from the query -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.signed', EXPECTED_SIGNED + ',ext1');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('22. signed has an extra field appended -> rejected by strict equality', async () => {
    let pairs = appendPair(defaultPairs(), 'openid.ext1', 'x');
    pairs = setValue(pairs, 'openid.signed', EXPECTED_SIGNED + ',ext1');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  // Defect 3 (docs/_security-review.md): C5's `missing_param` loop had no case that isolates
  // `openid.sig`. Every other name in REQUIRED_PARAMS is already forced present by C7 (the
  // `signed` equality) plus C8 (every name in `signed` must be present in the query), but `sig`
  // itself is never a member of `signed` — it is what the signature covers, not something it
  // signs — so it is uniquely protected by C5 alone.
  it('C5. openid.sig missing -> rejected, fetchSteam never called', async () => {
    const fetchSteam = vi.fn();
    const pairs = removeKey(defaultPairs(), 'openid.sig');
    const result = await run(pairs, { fetchSteam });
    expect(result.kind).toBe('rejected');
    expect(fetchSteam).not.toHaveBeenCalled();
  });

  it('23. extra unsigned param is accepted, and is absent from the captured request body', async () => {
    const fetchSteam = vi.fn<typeof fetch>();
    fetchSteam.mockImplementation(
      async () => new Response('ns:' + OPENID_NS + '\nis_valid:true\n', { status: 200 }),
    );
    const pairs = appendPair(defaultPairs(), 'openid.foo', 'bar');
    const result = await run(pairs, { fetchSteam });
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
    const [, init] = fetchSteam.mock.calls[0]!;
    const body = new URLSearchParams(
      await new Response(init?.body as ConstructorParameters<typeof Response>[0]).text(),
    );
    expect(body.has('openid.foo')).toBe(false);
  });
});

describe('return_to', () => {
  function withReturnTo(returnTo: string): Pair[] {
    return setValue(defaultPairs(), 'openid.return_to', returnTo);
  }

  it('24. host = dst.ty.ler.dev.evil.com -> rejected (no prefix matching)', async () => {
    const result = await run(
      withReturnTo(`https://dst.ty.ler.dev.evil.com${CALLBACK_PATH}?state=${STATE_ID}`),
    );
    expect(result.kind).toBe('rejected');
  });

  it('25. path traversal in return_to -> rejected', async () => {
    const result = await run(
      withReturnTo(`${PUBLIC_ORIGIN}${CALLBACK_PATH}/../../x?state=${STATE_ID}`),
    );
    expect(result.kind).toBe('rejected');
  });

  it('26. scheme = http in a prod-shaped config -> rejected', async () => {
    const result = await run(
      withReturnTo(`http://dst.ty.ler.dev${CALLBACK_PATH}?state=${STATE_ID}`),
    );
    expect(result.kind).toBe('rejected');
  });

  it('27. return_to state=A while the request query has state=B -> rejected', async () => {
    let pairs = withReturnTo(`${PUBLIC_ORIGIN}${CALLBACK_PATH}?state=${STATE_ID}`);
    pairs = setValue(pairs, 'state', randomBytes(32).toString('base64url'));
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('28. return_to has an extra query param absent from the request URL -> rejected', async () => {
    const result = await run(
      withReturnTo(`${PUBLIC_ORIGIN}${CALLBACK_PATH}?state=${STATE_ID}&extra=1`),
    );
    expect(result.kind).toBe('rejected');
  });

  it('29. request URL has extra params not in return_to -> accepted (one-directional subset rule)', async () => {
    const pairs = appendPair(defaultPairs(), 'utm_source', 'discord');
    const result = await run(pairs);
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
  });

  it('30. return_to with userinfo -> rejected', async () => {
    const result = await run(
      withReturnTo(`https://u:p@dst.ty.ler.dev${CALLBACK_PATH}?state=${STATE_ID}`),
    );
    expect(result.kind).toBe('rejected');
  });
});

describe('State / login CSRF', () => {
  it('31. no state cookie -> rejected', async () => {
    const result = await run(defaultPairs(), {}, []);
    expect(result.kind).toBe('rejected');
  });

  it('32. state cookie present, return_to has no state param -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.return_to', `${PUBLIC_ORIGIN}${CALLBACK_PATH}`);
    const withoutTopState = removeKey(pairs, 'state');
    const result = await run(withoutTopState);
    expect(result.kind).toBe('rejected');
  });

  it('33. cookie id != state query param -> rejected', async () => {
    const otherKey = stateKeyBytes();
    const cookies = [
      `dst_oidc_state=${stateCookieValue(randomBytes(32).toString('base64url'), STATE_ISSUED_AT, otherKey)}`,
    ];
    const result = await run(defaultPairs(), {}, cookies);
    expect(result.kind).toBe('rejected');
  });

  it('34. cookie with a corrupted MAC -> rejected', async () => {
    const parts = stateCookieValue(STATE_ID, STATE_ISSUED_AT, stateKeyBytes()).split('.');
    const corruptedMac = corruptBase64url(parts[2]!);
    const corrupted = `${parts[0]}.${parts[1]}.${corruptedMac}`;
    const result = await run(defaultPairs(), {}, [`dst_oidc_state=${corrupted}`]);
    expect(result.kind).toBe('rejected');
  });

  it('35. cookie with a MAC of the wrong length -> rejected, no timingSafeEqual throw', async () => {
    const cookie = `${STATE_ID}.${STATE_ISSUED_AT}.short`;
    const result = await run(defaultPairs(), {}, [`dst_oidc_state=${cookie}`]);
    expect(result.kind).toBe('rejected');
  });

  it('36. issuedAt exactly 600s old -> accepted; 601s -> rejected', async () => {
    const key = stateKeyBytes();
    const at600 = Math.floor(NOW_MS / 1000) - 600;
    const cookie600 = [`dst_oidc_state=${stateCookieValue(STATE_ID, at600, key)}`];
    const result600 = await run(defaultPairs(), {}, cookie600);
    expect(result600).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });

    const at601 = Math.floor(NOW_MS / 1000) - 601;
    const cookie601 = [`dst_oidc_state=${stateCookieValue(STATE_ID, at601, key)}`];
    const result601 = await run(defaultPairs(), {}, cookie601);
    expect(result601.kind).toBe('rejected');
  });

  it('37. replaying the same callback twice with an empty cookie header the second time -> second rejected', async () => {
    const first = await run(defaultPairs());
    expect(first.kind).toBe('ok');
    const second = await run(defaultPairs(), {}, []);
    expect(second.kind).toBe('rejected');
  });

  it('39. a state cookie minted with a different stateKey (different env) -> rejected', async () => {
    const otherEnvKey = Buffer.from('a-completely-different-state-key', 'utf8').subarray(0, 32);
    const cookie = [`dst_oidc_state=${stateCookieValue(STATE_ID, STATE_ISSUED_AT, otherEnvKey)}`];
    const result = await run(defaultPairs(), {}, cookie);
    expect(result.kind).toBe('rejected');
  });
});

describe('Nonce / replay', () => {
  it('40. response_nonce 10 minutes old -> rejected, fetchSteam never called', async () => {
    const fetchSteam = vi.fn();
    const nonce = `${isoPrefix(NOW_MS - 10 * 60 * 1000)}old`;
    const pairs = setValue(defaultPairs(), 'openid.response_nonce', nonce);
    const result = await run(pairs, { fetchSteam });
    expect(result.kind).toBe('rejected');
    expect(fetchSteam).not.toHaveBeenCalled();
  });

  it('41. response_nonce 10 minutes in the future -> rejected', async () => {
    const nonce = `${isoPrefix(NOW_MS + 10 * 60 * 1000)}future`;
    const pairs = setValue(defaultPairs(), 'openid.response_nonce', nonce);
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('42. response_nonce malformed -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.response_nonce', 'not-a-date-suffix');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('43. exactly 300s old -> accepted; 301s old -> rejected', async () => {
    const at300 = `${isoPrefix(NOW_MS - 300_000)}a`;
    const result300 = await run(setValue(defaultPairs(), 'openid.response_nonce', at300));
    expect(result300).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });

    const at301 = `${isoPrefix(NOW_MS - 301_000)}a`;
    const result301 = await run(setValue(defaultPairs(), 'openid.response_nonce', at301));
    expect(result301.kind).toBe('rejected');
  });

  it('44. 60s in the future -> accepted; 61s -> rejected', async () => {
    const at60 = `${isoPrefix(NOW_MS + 60_000)}a`;
    const result60 = await run(setValue(defaultPairs(), 'openid.response_nonce', at60));
    expect(result60).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });

    const at61 = `${isoPrefix(NOW_MS + 61_000)}a`;
    const result61 = await run(setValue(defaultPairs(), 'openid.response_nonce', at61));
    expect(result61.kind).toBe('rejected');
  });
});

describe('Steam response parsing', () => {
  it('45. is_valid:false -> rejected', async () => {
    const fetchSteam = vi.fn(
      async () => new Response(`ns:${OPENID_NS}\nis_valid:false\n`, { status: 200 }),
    );
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('rejected');
  });

  it('46. no substring matching on is_valid:true inside another value', async () => {
    const fetchSteam = vi.fn(async () => new Response('error:is_valid:true\n', { status: 200 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('rejected');
  });

  it('47. is_valid:true with no ns line -> rejected', async () => {
    const fetchSteam = vi.fn(async () => new Response('is_valid:true', { status: 200 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('rejected');
  });

  it('48. CRLF line endings -> accepted', async () => {
    const fetchSteam = vi.fn(
      async () => new Response(`ns:${OPENID_NS}\r\nis_valid:true\r\n`, { status: 200 }),
    );
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result).toEqual({ kind: 'ok', steamId64: FAKE_STEAM_ID });
  });

  it('49. 403 -> retryable, distinct from rejected', async () => {
    const fetchSteam = vi.fn(async () => new Response('', { status: 403 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('retryable');
  });

  it('50. 429 -> retryable', async () => {
    const fetchSteam = vi.fn(async () => new Response('', { status: 429 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('retryable');
  });

  it('51. 302 -> rejected or retryable, never ok', async () => {
    const fetchSteam = vi.fn(async () => new Response('', { status: 302 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).not.toBe('ok');
  });

  it('52. timeout (AbortError) -> retryable', async () => {
    const fetchSteam = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('retryable');
  });

  it('53. body longer than 4096 bytes -> rejected', async () => {
    // Defect 7 (docs/_security-review.md): the previous body, `'a'.repeat(5000)`, has no `:` in
    // it at all, so it was rejected by the `kv_parse` branch even with `MAX_KV_BODY_LEN` removed —
    // it pinned nothing about the length cap. This body is a genuinely well-formed, otherwise-ok
    // Key-Value Form response (every line has a `:`, `ns`/`is_valid` are correct) that is only
    // rejected because it exceeds 4096 bytes: with the length check removed it would parse
    // successfully and resolve `ok`.
    const padLine = 'pad:' + 'a'.repeat(4096);
    const body = `ns:${OPENID_NS}\nis_valid:true\n${padLine}\n`;
    expect(body.length).toBeGreaterThan(4096);
    const fetchSteam = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await run(defaultPairs(), { fetchSteam });
    expect(result.kind).toBe('rejected');
  });
});

describe('mode / ns / pollution', () => {
  it('54. mode = cancel -> cancelled, no session cookie', async () => {
    const pairs = setValue(defaultPairs(), 'openid.mode', 'cancel');
    const result = await run(pairs);
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('55. mode = "id_res " (trailing space) -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.mode', 'id_res ');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('56. mode missing -> rejected', async () => {
    const pairs = removeKey(defaultPairs(), 'openid.mode');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('57. ns = openid 1.1 namespace -> rejected', async () => {
    const pairs = setValue(defaultPairs(), 'openid.ns', 'http://openid.net/signon/1.1');
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('58. duplicate openid.claimed_id, good then evil -> rejected', async () => {
    const pairs = appendPair(
      defaultPairs(),
      'openid.claimed_id',
      'https://evil.example/openid/id/76561199000000002',
    );
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('59. duplicate openid.claimed_id, evil then good -> rejected', async () => {
    const pairs: Pair[] = [
      ['openid.claimed_id', 'https://evil.example/openid/id/76561199000000002'],
      ...defaultPairs(),
    ];
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('60. duplicate openid.signed -> rejected', async () => {
    const pairs = appendPair(defaultPairs(), 'openid.signed', EXPECTED_SIGNED);
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('61. duplicate state -> rejected', async () => {
    const pairs = appendPair(defaultPairs(), 'state', STATE_ID);
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  it('62. rawQueryString longer than 4096 chars -> rejected', async () => {
    const pairs = appendPair(defaultPairs(), 'padding', 'x'.repeat(5000));
    const result = await run(pairs);
    expect(result.kind).toBe('rejected');
  });

  // 63 (non-GET method on the callback -> 405) is a `describe('mode / ns / pollution (§2.7-2.9)')`
  // case in `completeSteamLogin.test.ts` instead of here: C0 (the method check) lives in
  // `completeSteamLogin` (index.ts), which is the only layer with access to the HTTP method —
  // `verifyCallback` never sees it. Same `describe` name, so its `fullName` groups correctly.
});
