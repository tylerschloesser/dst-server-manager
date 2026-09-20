// API error envelope (docs/control-plane.md §5.3). Body:
// `{ "error": { "code": "world_busy", "message": "..." } }`. Thrown by ports (e.g. the Identity
// adapter) and caught at the top of the router; anything else is an unhandled 500.
export type ErrorCode =
  | 'invalid_world_id'
  | 'unauthorized'
  | 'not_allowed'
  | 'csrf_failed'
  | 'world_not_found'
  | 'not_found'
  | 'method_not_allowed'
  | 'world_busy'
  | 'state_conflict'
  | 'launch_failed'
  | 'internal';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_world_id: 400,
  unauthorized: 401,
  not_allowed: 403,
  csrf_failed: 403,
  world_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  world_busy: 409,
  state_conflict: 409,
  launch_failed: 503,
  internal: 500,
};

export const DEFAULT_ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_world_id: 'World id is invalid',
  unauthorized: 'Sign in required',
  not_allowed: 'Not on the allowlist',
  csrf_failed: 'CSRF check failed',
  world_not_found: 'World not found',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  world_busy: 'Another world is starting',
  state_conflict: 'Too many concurrent updates',
  launch_failed: 'Could not start an instance right now',
  internal: 'Internal error',
};

/** Thrown by ports/handlers; caught once at the top of the router (docs/control-plane.md §5.3). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? DEFAULT_ERROR_MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export function errorBody(code: ErrorCode, message?: string): ErrorBody {
  return { error: { code, message: message ?? DEFAULT_ERROR_MESSAGE[code] } };
}
