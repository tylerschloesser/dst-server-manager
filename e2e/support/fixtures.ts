// docs/web.md §7: `test` extended with a signed-in context. Every scenario except "signed-out
// screen" and "not-allowed message" (docs/web.md §7 scenarios 1-2, which import `@playwright/test`
// directly so the browser starts with no cookie at all) imports `test`/`expect` from here instead.
//
// Two fixtures:
//  - `context` is overridden to carry a `dst_session` cookie for `FAKE_STEAM_ID`, minted by
//    `mintTestSession()`, before any page is created.
//  - `resetFakes` (auto) calls `control.reset()` before every test, restoring the two seeded
//    worlds `test-a`/`test-b`, both `stopped` (docs/web.md §7: "every spec calls reset() in
//    beforeEach").
import { test as base, expect } from '@playwright/test';
import * as controlOps from './control';
import { mintTestSession, sessionCookie } from './session';

export const test = base.extend<{ resetFakes: void }>({
  context: async ({ context }, use) => {
    await context.addCookies([sessionCookie(mintTestSession())]);
    await use(context);
  },
  resetFakes: [
    async ({ request }, use) => {
      await controlOps.reset(request);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export * as control from './control';
