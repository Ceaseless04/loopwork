import tseslint from 'typescript-eslint';

// Bare Node builtins that `node:*` does not cover (GM-9: graph is browser-loadable).
const bareBuiltins = ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'http', 'net', 'os', 'path', 'process', 'stream', 'url', 'util', 'zlib'];

const nodeGlobals = Object.fromEntries(
  ['console', 'process', 'Buffer', 'URL', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((g) => [g, 'readonly']),
);

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.diff', '.develop/**'] },
  ...tseslint.configs.recommended,
  {
    linterOptions: { noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' }],
    },
  },
  { files: ['packages/**'], rules: { 'no-console': 'error' } },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['packages/graph/**'],
    rules: {
      '@typescript-eslint/triple-slash-reference': ['error', { path: 'never', types: 'never', lib: 'never' }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', ...bareBuiltins], message: 'graph is browser-loadable' }] }],
    },
  },
);
