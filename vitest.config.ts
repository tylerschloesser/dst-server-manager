// Root Vitest config: runs the tests that live outside every workspace package
// (docs/decisions.md §16.40, docs/testing.md §1.1). `pnpm test` is `vitest run --passWithNoTests`
// (this config) followed by `pnpm -r test` (every package's own vitest.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
