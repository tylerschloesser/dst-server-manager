import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../vitest.setup.ts'],
    // Every test here runs a full `Template.fromStack()` synth, and the first one in each file
    // also pays aws-cdk-lib's JSII initialisation. That fits inside vitest's default 5 s on a
    // warm laptop but not on a GitHub runner: the first CI run failed with exactly three
    // timeouts, the first test of each of the three stack files, while the other 27 passed
    // (measured). Nothing is being weakened — the assertions are unchanged, they just get time
    // to finish. Kept well below a value that would hide a genuine hang.
    testTimeout: 30_000,
  },
});
