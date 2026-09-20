// DST_LOCAL_ONLY
//
// docs/decisions.md §16.37 / docs/testing.md §3: the test-only session secret. Reachable only
// through the `@dst/api/test-secret` subpath — never re-exported from `src/auth/index.ts` — so it
// stays out of `src/handlers/api.ts`'s import graph and therefore out of `dist/lambda/` and
// `cdk.out/`. Imported only by `src/local.ts`, `e2e/` and tests. Not a secret: it is a committed
// literal used solely by the local dev server and Playwright.
export const TEST_SESSION_SECRET = 'dst-local-test-secret-not-for-production';
