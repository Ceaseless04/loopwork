import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// GM-9: graph is browser-loadable. Exact-name `paths` (not gitignore-style patterns) so './util/index.js' stays legal.
const browserOnly = 'graph is browser-loadable';
const nodeGlobals = Object.fromEntries(Object.getOwnPropertyNames(globalThis).map((g) => [g, 'readonly']));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.diff', '.develop/**'] },
  ...tseslint.configs.recommended,
  {
    linterOptions: { noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 }],
    },
  },
  {
    files: ['packages/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'stdout', message: 'library code never writes stdout' },
        { object: 'globalThis', property: 'console', message: 'library code never writes stdout' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    languageOptions: { globals: nodeGlobals },
  },
  { files: ['scripts/**/*.mjs', 'eslint.config.js'], rules: { 'no-undef': 'error' } },
  {
    files: ['packages/graph/**'],
    rules: {
      '@typescript-eslint/triple-slash-reference': ['error', { path: 'never', types: 'never', lib: 'never' }],
      'no-restricted-imports': [
        'error',
        { paths: builtinModules.map((name) => ({ name, message: browserOnly })), patterns: [{ group: ['node:*'], message: browserOnly }] },
      ],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression:not([source.value=/^\\./])', message: browserOnly }],
      'no-restricted-globals': ['error', { name: 'process', message: browserOnly }],
    },
  },
);
