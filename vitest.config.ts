import { availableParallelism } from 'node:os';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

const ignored = ['**/node_modules/**', '**/dist/**'];

// Files named *.timed.test.ts hold wall-clock-guarded tests (an absolute `< N s` bound that coverage already makes tight):
// they start last, when the other files are mostly done, so the bound is not measured on a fully loaded machine.
class TimedLastSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const timed = (f: TestSpecification): boolean => f.moduleId.endsWith('.timed.test.ts');
    return [...sorted.filter((f) => !timed(f)), ...sorted.filter(timed)];
  }
}

export default defineConfig({
  test: {
    sequence: { sequencer: TimedLastSequencer },
    // Half the logical CPUs (physical cores): all of them, with v8 coverage on, slows the wall-clock-guarded perf tests ~1.5x (measured).
    maxWorkers: Math.max(2, Math.ceil(availableParallelism() / 2)),
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
