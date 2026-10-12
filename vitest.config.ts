import { defineConfig } from 'vitest/config';

const nonUnit = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text-summary'],
      include: ['packages/*/src/**', 'scripts/*.mjs'],
      exclude: ['vitest.config.ts', 'eslint.config.js', '**/dist/**', '**/node_modules/**'],
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['**/*.test.ts'], exclude: [...nonUnit, '**/*.pg.test.ts', '**/*.e2e.test.ts'] } },
      { extends: true, test: { name: 'pg', include: ['**/*.pg.test.ts'], exclude: nonUnit } },
      { extends: true, test: { name: 'e2e', include: ['**/*.e2e.test.ts'], exclude: nonUnit } },
    ],
  },
});
