// The single API client module (docs/web.md §2, §4): every fetch in the SPA goes through
// apiGet/apiPost, so the credential and CSRF-header rules live in exactly one place.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorResponseBody {
  error?: { code?: string; message?: string };
}

async function readErrorBody(res: Response): Promise<ErrorResponseBody> {
  try {
    return (await res.json()) as ErrorResponseBody;
  } catch {
    return {};
  }
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const parsed = await readErrorBody(res);
  throw new ApiError(
    res.status,
    parsed.error?.code,
    parsed.error?.message ?? `Request failed with status ${res.status}`,
  );
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  await throwIfNotOk(res);
  return (await res.json()) as T;
}

// No fetch in this app ever sends a request body. Bodyless POSTs avoid the
// CloudFront OAC x-amz-content-sha256 body-hash requirement (decisions.md §10).
// If you ever need to send data, read that section first — do not add a body here.
export async function apiPost(path: string): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-DST-Request': '1' },
  });
  await throwIfNotOk(res);
  return res;
}
