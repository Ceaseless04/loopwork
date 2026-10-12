import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createVitest } from 'vitest/node';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

const root = path.resolve(import.meta.dirname, '../..');

function readScripts(dir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

describe('SC-1 workspace', () => {
  it('SC-1: vitest projects separate *.test.ts, *.pg.test.ts and *.e2e.test.ts', async () => {
    expect(config.test?.projects).toHaveLength(3);

    const ctx = await createVitest('test', { watch: false, root });
    try {
      expect(ctx.projects.map((p) => p.name).sort()).toEqual(['e2e', 'pg', 'unit']);

      const matching = async (file: string): Promise<string[]> => {
        const hits: string[] = [];
        for (const p of ctx.projects) {
          if (await p.matchesTestGlob(path.join(root, file))) hits.push(p.name);
        }
        return hits;
      };

      expect(await matching('packages/graph/test/ids.test.ts')).toEqual(['unit']);
      expect(await matching('scripts/test/sc-1-workspace.test.ts')).toEqual(['unit']);
      expect(await matching('packages/eventlog/test/store.pg.test.ts')).toEqual(['pg']);
      expect(await matching('tests/gate.e2e.test.ts')).toEqual(['e2e']);
      expect(await matching('packages/graph/node_modules/dep/x.test.ts')).toEqual([]);
      expect(await matching('packages/graph/dist/x.test.ts')).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('SC-1: root and every package expose build/typecheck/lint/test scripts', () => {
    const rootScripts = readScripts(root);
    for (const name of ['build', 'typecheck', 'lint', 'test']) expect(rootScripts[name], `root ${name}`).toBeTruthy();
    expect(rootScripts['test']).toBe('vitest run --project unit');
    expect(rootScripts['test:pg']).toBe('vitest run --project pg --passWithNoTests');
    expect(rootScripts['test:e2e']).toBe('vitest run --project e2e --passWithNoTests');

    // `lint` is a single repo-wide `eslint .` at the root, so packages only carry build/typecheck/test.
    const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(packages.map((d) => d.name)).toEqual(expect.arrayContaining(['eventlog', 'graph', 'windows']));
    for (const d of packages) {
      const scripts = readScripts(path.join(root, 'packages', d.name));
      for (const name of ['build', 'typecheck', 'test']) expect(scripts[name], `${d.name} ${name}`).toBeTruthy();
    }
    expect(readScripts(path.join(root, 'packages', 'eventlog'))['test:pg']).toBeTruthy();
  });
});
