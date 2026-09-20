// Extends the root flat config (owned by the orchestrator, not this package) and adds one thing
// this package needs: the committed CDK-fixture Lambda stubs under test/fixtures/api-bundle/ are
// deliberately CommonJS one-liners (docs/infra.md §7 — `exports.handler = async () => (...)`, the
// exact bytes the real esbuild output looks like), never linted as an ES module.
import rootConfig from '../../eslint.config.js';

export default [
  ...rootConfig,
  {
    files: ['test/fixtures/api-bundle/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { exports: 'writable', module: 'writable', require: 'readonly' },
    },
  },
];
