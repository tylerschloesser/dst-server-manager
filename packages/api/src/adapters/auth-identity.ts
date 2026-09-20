// Identity port (docs/control-plane.md §5.1) implemented on top of `src/auth/index.ts`'s
// `requireUser` (docs/auth.md §6). This is what `handlers/api.ts` and `local.ts` hand to the
// world routes; it throws `ApiError` on failure so the router's single catch-all handles it.
import { requireUser } from '../auth';
import type { AuthDeps } from '../auth';
import { ApiError } from '../errors';
import type { HttpRequest, Identity } from '../ports';

export function createAuthIdentity(deps: AuthDeps): Identity {
  return {
    async requireUser(req: HttpRequest) {
      const result = await requireUser(req, deps);
      if (!result.ok) {
        throw new ApiError(result.code, undefined);
      }
      return result.user;
    },
  };
}
