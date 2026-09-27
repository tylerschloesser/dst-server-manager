import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { RecapsResponse } from '@dst/shared';
import { ApiError } from './client';
import { fetchRecaps, noteHeaders, recapsQueryKey, saveNoteMutationOptions } from './recaps';

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const empty: RecapsResponse = { worldId: 'test-a', note: null, recaps: [] };

afterEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(notifications.show).mockReset();
});

describe('noteHeaders', () => {
  it('URI-encodes the note into x-dst-note (header values must be ASCII)', () => {
    expect(noteHeaders('Bring ice 🧊, then caves')).toEqual({
      'x-dst-note': 'Bring%20ice%20%F0%9F%A7%8A%2C%20then%20caves',
    });
    expect(noteHeaders('')).toEqual({ 'x-dst-note': '' });
  });
});

describe('fetchRecaps', () => {
  it('GETs the world recaps', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, empty));
    await expect(fetchRecaps('test-a')).resolves.toEqual(empty);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/worlds/test-a/recaps');
  });
});

describe('saveNoteMutationOptions', () => {
  it('POSTs bodyless with the note header and writes the note into the cached recaps', async () => {
    const note = { text: 'Bring ice', updatedAt: '2026-09-27T12:00:00.000Z', updatedBy: 'Dev' };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { note }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(recapsQueryKey('test-a'), empty);

    await new MutationObserver(queryClient, saveNoteMutationOptions(queryClient, 'test-a')).mutate(
      'Bring ice',
    );

    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/worlds/test-a/note');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ 'x-dst-note': 'Bring%20ice', 'X-DST-Request': '1' });
    expect(queryClient.getQueryData<RecapsResponse>(recapsQueryKey('test-a'))?.note).toEqual(note);
  });

  it('shows the server message for invalid_note', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'invalid_note', message: 'Note is too long' } }),
    );
    const queryClient = new QueryClient();
    const observer = new MutationObserver(
      queryClient,
      saveNoteMutationOptions(queryClient, 'test-a'),
    );
    await expect(observer.mutate('x')).rejects.toBeInstanceOf(ApiError);
    expect(notifications.show).toHaveBeenCalledWith({
      color: 'yellow',
      title: "Couldn't save the note",
      message: 'Note is too long',
    });
  });

  it('a 401 signs out without a notification', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: { code: 'unauthorized' } }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { nickname: 'Dev' });
    const observer = new MutationObserver(
      queryClient,
      saveNoteMutationOptions(queryClient, 'test-a'),
    );
    await expect(observer.mutate('x')).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(['me'])).toBeNull();
    expect(notifications.show).not.toHaveBeenCalled();
  });
});
