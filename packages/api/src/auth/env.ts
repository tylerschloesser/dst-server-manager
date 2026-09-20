// docs/auth.md §0: the module-load assertions. `APP_ENV` and `PUBLIC_ORIGIN` are read directly
// from `process.env` here (never from a header, query param or cookie) and validated once, at
// import time, so the Lambda fails closed at init rather than on the first request. Every other
// file in this package that needs the env discriminator takes it as an explicit parameter instead
// of importing `process.env` itself, which keeps them pure and unit-testable; only `index.ts`
// (the real Lambda's entry into this package) reads these constants.
import type { AppEnv } from './constants';

function validateAppEnv(raw: string | undefined): AppEnv {
  if (raw === 'prod' || raw === 'test' || raw === 'local') return raw;
  throw new Error(`invalid APP_ENV: ${JSON.stringify(raw)}`);
}

function validatePublicOrigin(raw: string | undefined, appEnv: AppEnv): string {
  if (raw === undefined || raw === '' || raw.endsWith('/')) {
    throw new Error(`invalid PUBLIC_ORIGIN: ${JSON.stringify(raw)}`);
  }
  const pattern =
    appEnv === 'prod' ? /^https:\/\/[a-z0-9.-]+$/ : /^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/;
  if (!pattern.test(raw)) {
    throw new Error(`invalid PUBLIC_ORIGIN: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Module-load assertion 1 of docs/auth.md §0. */
export const APP_ENV: AppEnv = validateAppEnv(process.env['APP_ENV']);

/** Module-load assertion 2 of docs/auth.md §0. */
export const PUBLIC_ORIGIN: string = validatePublicOrigin(process.env['PUBLIC_ORIGIN'], APP_ENV);

/** Module-load assertion 3 of docs/auth.md §0: the prod entry never constructs the test secret
 * source in the first place (that belongs to `local.ts` only), but this is a second belt — if
 * someone sets `DEV_SESSION_SECRET` in the prod Lambda's environment, fail closed at init. */
if (APP_ENV === 'prod' && process.env['DEV_SESSION_SECRET'] !== undefined) {
  throw new Error('DEV_SESSION_SECRET must not be set when APP_ENV=prod');
}
