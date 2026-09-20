// docs/control-plane.md §5.3: the error envelope and its code -> status mapping.
import { describe, expect, it } from 'vitest';

import { ApiError, ERROR_STATUS, errorBody } from './errors';

describe('ApiError', () => {
  it('maps every documented code to its status', () => {
    expect(ERROR_STATUS.invalid_world_id).toBe(400);
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.not_allowed).toBe(403);
    expect(ERROR_STATUS.csrf_failed).toBe(403);
    expect(ERROR_STATUS.world_not_found).toBe(404);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.method_not_allowed).toBe(405);
    expect(ERROR_STATUS.world_busy).toBe(409);
    expect(ERROR_STATUS.state_conflict).toBe(409);
    expect(ERROR_STATUS.launch_failed).toBe(503);
    expect(ERROR_STATUS.internal).toBe(500);
  });

  it('carries the mapped status and a default message', () => {
    const err = new ApiError('world_busy');
    expect(err.status).toBe(409);
    expect(err.code).toBe('world_busy');
    expect(err.message).toBe('Another world is starting');
  });

  it('accepts a custom message', () => {
    const err = new ApiError('state_conflict', 'custom message');
    expect(err.message).toBe('custom message');
  });
});

describe('errorBody', () => {
  it('builds the exact envelope shape', () => {
    expect(errorBody('world_not_found')).toEqual({
      error: { code: 'world_not_found', message: 'World not found' },
    });
  });

  it('uses a supplied message over the default', () => {
    expect(errorBody('internal', 'boom')).toEqual({
      error: { code: 'internal', message: 'boom' },
    });
  });
});
