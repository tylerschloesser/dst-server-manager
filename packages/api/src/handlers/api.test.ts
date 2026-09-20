// Defect 10 (docs/_security-review.md): the production `AllowlistSource` must not swallow a
// malformed `/dst/users` into a fake-valid `{}`. `../auth/allowlist.ts`'s `fetchAndValidate`
// already classifies a thrown read as reason `json` (SyntaxError) or `ssm` (anything else), logs
// it once via `console.log`, and never caches the bad value — this file proves the *adapter* now
// participates in that classification instead of hiding the failure, and that the failure stays
// distinguishable from an honestly empty allowlist (which must not be logged as an error at all).
//
// `./api` is the real Lambda entry: importing it runs `../auth/index.ts`'s module-load
// assertions (docs/auth.md §0), which read `process.env.APP_ENV`/`PUBLIC_ORIGIN` at import time.
// So, like `completeSteamLogin.test.ts`, this file sets those before a dynamic `import('./api')`
// instead of a static import.
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PARAM_USERS } from '@dst/shared';

import { getAllowlist } from '../auth/allowlist';
import type { AllowlistSource } from '../auth/allowlist';

process.env['APP_ENV'] = 'test';
process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';

const { createAllowlistSource } = await import('./api');

function fakeClient(value: string | undefined): SSMClient {
  const send = vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect((command as GetParameterCommand).input.Name).toBe(PARAM_USERS);
    return { Parameter: value === undefined ? undefined : { Value: value } };
  });
  return { send } as unknown as SSMClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAllowlistSource (defect 10)', () => {
  it('malformed JSON throws, is classified "json", and the map is not cached as valid', async () => {
    const source: AllowlistSource = createAllowlistSource(fakeClient('{not valid json'));
    await expect(source.getUsers()).rejects.toBeInstanceOf(SyntaxError);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await getAllowlist(source, () => 0);
    expect(result).toEqual({});
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ evt: 'auth.allowlist', error: 'json' }));
  });

  it('a well-formed JSON array (non-object) throws and is classified "ssm", not silently "shape"', async () => {
    const source: AllowlistSource = createAllowlistSource(fakeClient('[]'));
    await expect(source.getUsers()).rejects.toThrow('/dst/users value is not a JSON object');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await getAllowlist(source, () => 0);
    expect(result).toEqual({});
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ evt: 'auth.allowlist', error: 'ssm' }));
  });

  it('a missing parameter value throws and is classified "ssm"', async () => {
    const source: AllowlistSource = createAllowlistSource(fakeClient(undefined));
    await expect(source.getUsers()).rejects.toThrow();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await getAllowlist(source, () => 0);
    expect(result).toEqual({});
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ evt: 'auth.allowlist', error: 'ssm' }));
  });

  it('a genuinely empty allowlist ({}) resolves cleanly and is never logged as an error', async () => {
    const source: AllowlistSource = createAllowlistSource(fakeClient('{}'));
    await expect(source.getUsers()).resolves.toEqual({});

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await getAllowlist(source, () => 0);
    expect(result).toEqual({});
    // The distinguishing property defect 10 is about: a malformed parameter and an honestly
    // empty one both end up `{}` from `getAllowlist`, but only the malformed one logs an error.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a well-formed non-empty allowlist round-trips through the real SSM shape', async () => {
    const source: AllowlistSource = createAllowlistSource(
      fakeClient(JSON.stringify({ '76561190000000001': 'Tyler' })),
    );
    await expect(source.getUsers()).resolves.toEqual({ '76561190000000001': 'Tyler' });
  });
});
