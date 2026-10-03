import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { MutationObserverOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { NotesResponse, RecapsResponse } from '@dst/shared';
import { ApiError } from './client';
import {
  addNoteMutationOptions,
  deleteNoteMutationOptions,
  editNoteMutationOptions,
  fetchRecaps,
  noteHeaders,
  recapsQueryKey,
} from './recaps';

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const empty: RecapsResponse = { worldId: 'test-a', notes: [], recaps: [] };
const ID = '00000000-0000-4000-8000-000000000001';
const note = {
  id: ID,
  text: 'Bring ice',
  createdAt: '2026-10-03T12:00:00.000Z',
  createdBy: 'Dev',
  editedAt: null,
  editedBy: null,
};

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

describe('note mutations', () => {
  it.each([
    ['add', addNoteMutationOptions, 'Bring ice', '/api/worlds/test-a/notes', 'Bring%20ice'],
    [
      'edit',
      editNoteMutationOptions,
      { id: ID, text: 'Bring ice' },
      `/api/worlds/test-a/notes/${ID}`,
      'Bring%20ice',
    ],
    ['delete', deleteNoteMutationOptions, ID, `/api/worlds/test-a/notes/${ID}/delete`, null],
  ] as const)(
    '%s POSTs bodyless to its path and writes the returned list into the cached recaps',
    async (_label, options, vars, expectedPath, header) => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { notes: [note] }));
      const queryClient = new QueryClient();
      queryClient.setQueryData(recapsQueryKey('test-a'), empty);

      // The three option types differ only in their variables; erase that for the table.
      const opts = options(queryClient, 'test-a') as unknown as MutationObserverOptions<
        NotesResponse,
        unknown,
        unknown
      >;
      await new MutationObserver(queryClient, opts).mutate(vars);

      const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(path).toBe(expectedPath);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual(
        header === null ? { 'X-DST-Request': '1' } : { 'x-dst-note': header, 'X-DST-Request': '1' },
      );
      expect(queryClient.getQueryData<RecapsResponse>(recapsQueryKey('test-a'))?.notes).toEqual([
        note,
      ]);
    },
  );

  it('note_not_found refetches the recaps and says why', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { error: { code: 'note_not_found', message: 'gone' } }),
    );
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const observer = new MutationObserver(
      queryClient,
      editNoteMutationOptions(queryClient, 'test-a'),
    );
    await expect(observer.mutate({ id: ID, text: 'x' })).rejects.toBeInstanceOf(ApiError);
    expect(spy).toHaveBeenCalledWith({ queryKey: recapsQueryKey('test-a') });
    expect(notifications.show).toHaveBeenCalledWith({
      color: 'yellow',
      title: "Couldn't save the note",
      message: 'Someone deleted that note.',
    });
  });

  it('shows the server message for too_many_notes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'too_many_notes', message: 'At most 50' } }),
    );
    const queryClient = new QueryClient();
    const observer = new MutationObserver(
      queryClient,
      addNoteMutationOptions(queryClient, 'test-a'),
    );
    await expect(observer.mutate('x')).rejects.toBeInstanceOf(ApiError);
    expect(notifications.show).toHaveBeenCalledWith({
      color: 'yellow',
      title: "Couldn't save the note",
      message: 'At most 50',
    });
  });

  it('shows the server message for invalid_note', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'invalid_note', message: 'Note is too long' } }),
    );
    const queryClient = new QueryClient();
    const observer = new MutationObserver(
      queryClient,
      addNoteMutationOptions(queryClient, 'test-a'),
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
      addNoteMutationOptions(queryClient, 'test-a'),
    );
    await expect(observer.mutate('x')).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryData(['me'])).toBeNull();
    expect(notifications.show).not.toHaveBeenCalled();
  });
});
