import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost, ApiError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiGet', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('sends credentials and an Accept header, and returns the parsed body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { nickname: 'Dev' }));

    const result = await apiGet<{ nickname: string }>('/api/me');

    expect(result).toEqual({ nickname: 'Dev' });
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/me');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ Accept: 'application/json' });
    expect(init.method).toBeUndefined();
  });

  it('throws an ApiError with the status and code on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'not_allowed', message: 'nope' } }),
    );

    await expect(apiGet('/api/me')).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
  });

  it('still throws an ApiError when the error body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('oops', { status: 500 }));

    const err: unknown = await apiGet('/api/me').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

describe('apiPost', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('sends a bodyless POST with the CSRF header and no Content-Type', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {}));

    await apiPost('/api/worlds/test-a/start');

    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/worlds/test-a/start');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'X-DST-Request': '1' });
    expect(init.body).toBeUndefined();
  });

  it('throws an ApiError on failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'world_busy', message: 'busy' } }),
    );

    await expect(apiPost('/api/worlds/test-a/start')).rejects.toMatchObject({
      status: 409,
      code: 'world_busy',
    });
  });
});
