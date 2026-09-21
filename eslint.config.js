// Flat config (ESLint 9+) + typescript-eslint + Prettier (docs/decisions.md §4).
// One config, applied from the repo root, covers every package plus e2e/ and scripts/
// (docs/testing.md §1.1).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
  },
  // The SPA ships to a browser, where `@dst/shared`'s barrel is poison: it re-exports `ids.ts`,
  // which imports `node:crypto`, and Vite externalizes that — the whole app then fails at module
  // evaluation on `randomBytes` and every e2e test reports "element(s) not found" with nothing in
  // the SPA's own code to point at (measured while adding the join hostname, decisions §17).
  // Types are erased, so `import type` from the barrel stays fine; values come from the
  // `@dst/shared/constants` subpath (docs/control-plane.md §1.0).
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@dst/shared',
              allowTypeImports: true,
              message:
                "Import values from '@dst/shared/constants'; the barrel reaches node:crypto and breaks the browser bundle.",
            },
          ],
        },
      ],
    },
  },
);
