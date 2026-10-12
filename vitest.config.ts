import { defineConfig } from 'vitest/config';

const ignored = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text-summary'],
      include: ['packages/*/src/**', 'scripts/*.mjs'],
      exclude: ['vitest.config.ts', 'eslint.config.js'],
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['**/*.test.ts'], exclude: [...ignored, '**/*.pg.test.ts', '**/*.e2e.test.ts'] } },
      { extends: true, test: { name: 'pg', include: ['**/*.pg.test.ts'], exclude: ignored } },
      { extends: true, test: { name: 'e2e', include: ['**/*.e2e.test.ts'], exclude: ignored } },
    ],
  },
});
