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

/** Repo-relative paths of every *.test.ts outside node_modules, dist and .git (Node 20 has no fs.globSync). */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'dist', '.git'].includes(e.name)) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return testFiles(full);
    return e.name.endsWith('.test.ts') ? [path.relative(root, full)] : [];
  });
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
      expect(await matching('packages/graph/src/x.test.ts')).toEqual(['unit']);
      expect(await matching('tests/x.test.ts')).toEqual(['unit']);
      expect(await matching('packages/graph/test/x.pg.test.ts')).toEqual(['pg']);
      expect(await matching('packages/graph/test/x.e2e.test.ts')).toEqual(['e2e']);
      expect(await matching('packages/graph/node_modules/dep/x.test.ts')).toEqual([]);
      expect(await matching('packages/graph/dist/x.test.ts')).toEqual([]);

      for (const file of testFiles(root)) expect(await matching(file), file).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('SC-1: root and every package expose build/typecheck/lint/test scripts', () => {
    const rootScripts = readScripts(root);
    for (const name of ['build', 'typecheck', 'lint', 'test']) expect(rootScripts[name], `root ${name}`).toBeTruthy();
    // T05 wraps the root `test` in scripts/test.mjs (`node scripts/test.mjs --project unit`), so only pin the project.
    expect(rootScripts['test']).toMatch(/--project unit(\s|$)/);
    expect(rootScripts['test:pg']).toBe('vitest run --project pg --passWithNoTests');
    expect(rootScripts['test:e2e']).toBe('vitest run --project e2e --passWithNoTests');

    // `lint` is a single repo-wide `eslint .` at the root, so packages only carry build/typecheck/test.
    const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(packages.map((d) => d.name)).toEqual(expect.arrayContaining(['eventlog', 'graph', 'windows']));
    for (const d of packages) {
      const scripts = readScripts(path.join(root, 'packages', d.name));
      for (const name of ['build', 'typecheck']) expect(scripts[name], `${d.name} ${name}`).toBeTruthy();
      expect(scripts['test'], `${d.name} test`).toBe(`vitest run --root ../.. --project unit --passWithNoTests packages/${d.name}/`);
    }
    expect(readScripts(path.join(root, 'packages', 'eventlog'))['test:pg']).toBe(
      'vitest run --root ../.. --project pg --passWithNoTests packages/eventlog/',
    );
  });

  it('SC-1: coverage is v8 with an lcov report over every package source file', () => {
    expect(config.test?.coverage).toMatchObject({ provider: 'v8', include: ['packages/*/src/**', 'scripts/*.mjs'] });
    expect(config.test?.coverage?.reporter).toEqual(expect.arrayContaining(['lcov', 'text-summary']));
    expect(config.test?.coverage?.exclude).toEqual(['vitest.config.ts', 'eslint.config.js']);
  });
});
