// @dst/api/auth — the subpath imported by e2e/support/session.ts, scripts/mint-cookie.ts and
// scripts/lifecycle-test.ts (docs/decisions.md §16.32, docs/auth.md §9.3). Does NOT re-export
// TEST_SESSION_SECRET (docs/decisions.md §16.37). Filled in by a later task.
export const AUTH_MODULE_NAME = '@dst/api/auth';
