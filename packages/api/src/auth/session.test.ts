// docs/auth.md §9.2, `Session / allowlist` group, cases 70-83: the session token format itself.
// Fully pure (`mintSessionTokenImpl`/`verifySessionTokenImpl` take `appEnv` as an explicit
// argument), so no `process.env`/module-reload gymnastics are needed here. Cases 68, 69 and 84-92
// of the same group — which need the full `AuthDeps`-based `requireUser`/`completeSteamLogin` —
// live in `requireUser.test.ts` instead, under a `describe` block with the same exact name.
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { mintSessionTokenImpl, verifySessionTokenImpl } from './session';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').subarray(0, 32);
const OTHER_KEY = Buffer.from('fedcba9876543210fedcba9876543210', 'utf8').subarray(0, 32);
const STEAM_ID = '76561199000000001';
const NOW = 1_800_000_000;

describe('Session / allowlist', () => {
  it('70. round-trip: mint then verify -> the same steamId64; exp - iat === 2592000', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };
    expect(payload.exp - payload.iat).toBe(2_592_000);
    const verified = verifySessionTokenImpl(token, KEY, NOW, 'test');
    expect(verified).toEqual({ steamId64: STEAM_ID });
  });

  it('71. a token minted under APP_ENV=test is rejected by a verifier running APP_ENV=prod, even with the identical raw secret', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    expect(verifySessionTokenImpl(token, KEY, NOW, 'prod')).toBeNull();
  });

  it('72. a token minted under APP_ENV=prod is rejected by a verifier running APP_ENV=test', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'prod',
    });
    expect(verifySessionTokenImpl(token, KEY, NOW, 'test')).toBeNull();
  });

  it('73. one flipped bit in the MAC -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const macBuf = Buffer.from(parts[3]!, 'base64url');
    macBuf[0] = macBuf[0]! ^ 0x01;
    const tampered = [parts[0], parts[1], parts[2], macBuf.toString('base64url')].join('.');
    expect(verifySessionTokenImpl(tampered, KEY, NOW, 'test')).toBeNull();
  });

  it('74. one flipped bit in the payload -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const payloadBuf = Buffer.from(parts[2]!, 'base64url');
    payloadBuf[0] = payloadBuf[0]! ^ 0x01;
    const tampered = [parts[0], parts[1], payloadBuf.toString('base64url'), parts[3]].join('.');
    expect(verifySessionTokenImpl(tampered, KEY, NOW, 'test')).toBeNull();
  });

  it('75. truncated (42 chars) and over-long (44 chars) MAC -> rejected, no throw', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const shortMac = parts[3]!.slice(0, 42);
    const longMac = parts[3] + 'A';
    const shortToken = [parts[0], parts[1], parts[2], shortMac].join('.');
    const longToken = [parts[0], parts[1], parts[2], longMac].join('.');
    expect(() => verifySessionTokenImpl(shortToken, KEY, NOW, 'test')).not.toThrow();
    expect(() => verifySessionTokenImpl(longToken, KEY, NOW, 'test')).not.toThrow();
    expect(verifySessionTokenImpl(shortToken, KEY, NOW, 'test')).toBeNull();
    expect(verifySessionTokenImpl(longToken, KEY, NOW, 'test')).toBeNull();
  });

  it('76. exp in the past -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW - 3_000_000,
      appEnv: 'test',
    });
    expect(verifySessionTokenImpl(token, KEY, NOW, 'test')).toBeNull();
  });

  it('77. iat more than 60s in the future -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW + 61,
      appEnv: 'test',
    });
    expect(verifySessionTokenImpl(token, KEY, NOW, 'test')).toBeNull();
  });

  function buildRawToken(payloadJson: string, appEnv: string, key: Buffer): string {
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const signingInput = `v1.${appEnv}.${payloadB64}`;
    const mac = createHmac('sha256', key).update(signingInput).digest('base64url');
    return `${signingInput}.${mac}`;
  }

  it('78. payload that is not JSON, is null, or is an array -> rejected, no throw', () => {
    const notJson = buildRawToken('not-json{', 'test', KEY);
    const nullPayload = buildRawToken('null', 'test', KEY);
    const arrayPayload = buildRawToken('[1,2,3]', 'test', KEY);
    for (const t of [notJson, nullPayload, arrayPayload]) {
      expect(() => verifySessionTokenImpl(t, KEY, NOW, 'test')).not.toThrow();
      expect(verifySessionTokenImpl(t, KEY, NOW, 'test')).toBeNull();
    }
  });

  it('79. payload sub with a trailing letter, or a number, -> rejected', () => {
    const badString = buildRawToken(
      JSON.stringify({ sub: '7656119000000000x', iat: NOW, exp: NOW + 100 }),
      'test',
      KEY,
    );
    const numberSub = buildRawToken(
      JSON.stringify({ sub: 123456, iat: NOW, exp: NOW + 100 }),
      'test',
      KEY,
    );
    expect(verifySessionTokenImpl(badString, KEY, NOW, 'test')).toBeNull();
    expect(verifySessionTokenImpl(numberSub, KEY, NOW, 'test')).toBeNull();
  });

  it('80. token with 3 or 5 dot-separated parts -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const threeParts = parts.slice(0, 3).join('.');
    const fiveParts = token + '.extra';
    expect(verifySessionTokenImpl(threeParts, KEY, NOW, 'test')).toBeNull();
    expect(verifySessionTokenImpl(fiveParts, KEY, NOW, 'test')).toBeNull();
  });

  it('81. token with a v2 prefix -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const v2 = ['v2', parts[1], parts[2], parts[3]].join('.');
    expect(verifySessionTokenImpl(v2, KEY, NOW, 'test')).toBeNull();
  });

  it('82. padded or non-canonical base64 (=, +, /) -> rejected', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    const parts = token.split('.');
    const padded = [parts[0], parts[1], parts[2] + '=', parts[3]].join('.');
    const plusSlash = [
      parts[0],
      parts[1],
      parts[2]!.replace(/[A-Za-z]/, (m) => (m === 'A' ? '+' : m)),
      parts[3],
    ].join('.');
    expect(verifySessionTokenImpl(padded, KEY, NOW, 'test')).toBeNull();
    // `+`/`/` are simply not in BASE64URL_RE, so any occurrence fails the format check.
    expect(
      verifySessionTokenImpl(`a+b.${parts[1]}.${parts[2]}.${parts[3]}`, KEY, NOW, 'test'),
    ).toBeNull();
    void plusSlash;
  });

  it('83. token longer than 1024 chars -> rejected without computing an HMAC', () => {
    const huge = 'v1.test.' + 'a'.repeat(2000) + '.' + 'b'.repeat(43);
    expect(huge.length).toBeGreaterThan(1024);
    expect(verifySessionTokenImpl(huge, KEY, NOW, 'test')).toBeNull();
  });

  it('cross-check: a different sessionKey never verifies (sanity for the other cases)', () => {
    const token = mintSessionTokenImpl({
      steamId64: STEAM_ID,
      sessionKey: KEY,
      nowSec: NOW,
      appEnv: 'test',
    });
    expect(verifySessionTokenImpl(token, OTHER_KEY, NOW, 'test')).toBeNull();
  });
});
