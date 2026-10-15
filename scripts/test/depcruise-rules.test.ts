import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTsConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { describe, expect, it } from 'vitest';

// SC-3: the architecture rules of CONSTRAINTS.md are enforced by .dependency-cruiser.cjs. Each fixture under
// scripts/test/fixtures/depcruise is a miniature repo (fixture-local tsconfig paths map @loopwork/<pkg> to its src/index.ts)
// that violates exactly one rule; the real config is run with the fixture as root and the violated edges are compared exactly.
const root = path.resolve(import.meta.dirname, '../..');
const configFile = path.join(root, '.dependency-cruiser.cjs');
const fixtures = path.join(import.meta.dirname, 'fixtures/depcruise');

/** Cruise one fixture with the real config; returns `<rule>: <from> -> <to>` per violation, sorted. */
async function violations(fixture: string): Promise<string[]> {
  const { options, ...ruleSet } = await extractDepcruiseConfig(configFile);
  const dir = path.join(fixtures, fixture);
  const tsConfig = path.join(dir, 'tsconfig.json');
  // tsPreCompilationDeps (needed to see `import type`) also needs the parsed tsconfig as the 4th argument.
  const { output } = await cruise(['.'], { ...options, ruleSet, validate: true, baseDir: dir }, { tsconfig: tsConfig }, { tsConfig: extractTsConfig(tsConfig) });
  if (typeof output === 'string') throw new Error('expected the cruise result object');
  return output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
}

const cases: { n: number; rule: string; what: string; edges: string[] }[] = [
  {
    n: 1,
    rule: 'rule-01-graph-isolated',
    what: 'graph imports another package (value and type) and a node: module',
    edges: ['packages/graph/src/index.ts -> fs', 'packages/graph/src/index.ts -> packages/eventlog/src/index.ts', 'packages/graph/src/index.ts -> packages/windows/src/index.ts'],
  },
  {
    n: 2,
    rule: 'rule-02-eventlog-type-graph-only',
    what: 'eventlog value-imports graph and imports another package',
    edges: ['packages/eventlog/src/index.ts -> packages/graph/src/index.ts', 'packages/eventlog/src/index.ts -> packages/windows/src/index.ts'],
  },
  {
    n: 3,
    rule: 'rule-03-windows-isolated',
    what: 'windows imports any @loopwork package',
    edges: ['packages/windows/src/index.ts -> packages/eventlog/src/index.ts', 'packages/windows/src/index.ts -> packages/graph/src/index.ts'],
  },
  {
    n: 4,
    rule: 'rule-04-engine-layering',
    what: 'engine imports runtime, service, ui-server, mcp and apps',
    edges: ['apps/cli', 'packages/mcp', 'packages/runtime', 'packages/service', 'packages/ui-server'].map((t) => `packages/engine/src/index.ts -> ${t}/src/index.ts`),
  },
  {
    n: 5,
    rule: 'rule-05-runtime-layering',
    what: 'runtime imports service and a front door',
    edges: ['packages/runtime/src/index.ts -> packages/service/src/index.ts', 'packages/runtime/src/index.ts -> packages/ui-server/src/index.ts'],
  },
  {
    n: 6,
    rule: 'rule-06-service-layering',
    what: 'service imports ui-server, mcp, apps and integrations',
    edges: ['apps/cli', 'integrations/claude', 'packages/mcp', 'packages/ui-server'].map((t) => `packages/service/src/index.ts -> ${t}/src/index.ts`),
  },
  {
    n: 7,
    rule: 'rule-07-front-door-no-engine-side',
    what: 'front doors value-import pg, engine, runtime and eventlog',
    edges: [
      'apps/cli/src/index.ts -> packages/runtime/src/index.ts',
      'integrations/claude/src/index.ts -> packages/eventlog/src/index.ts',
      'packages/mcp/src/index.ts -> packages/engine/src/index.ts',
      'packages/ui-server/src/index.ts -> pg',
    ],
  },
  {
    n: 8,
    rule: 'rule-08-ui-viewer-narrow',
    what: 'ui-viewer imports a non-graph value, a node: module and a non-type service import',
    edges: ['apps/ui-viewer/src/index.ts -> packages/eventlog/src/index.ts', 'apps/ui-viewer/src/index.ts -> packages/service/src/index.ts', 'apps/ui-viewer/src/index.ts -> path'],
  },
  {
    n: 9,
    rule: 'rule-09-cli-claude-dynamic-only',
    what: 'cli statically imports claude-integration and claude-integration imports cli values',
    edges: ['apps/cli/src/index.ts -> integrations/claude/src/index.ts', 'integrations/claude/src/index.ts -> apps/cli/src/helper.ts'],
  },
  {
    n: 10,
    rule: 'rule-10-no-circular',
    what: 'a two-file cycle',
    edges: ['packages/service/src/a.ts -> packages/service/src/b.ts'],
  },
];

describe('SC-3: dependency-cruiser architecture rules', () => {
  for (const { n, rule, what, edges } of cases) {
    it(`SC-3: rule ${n} (${what}) is reported as ${rule} and nothing else`, async () => {
      expect(await violations(rule)).toEqual(edges.map((e) => `${rule}: ${e}`));
    }, 60_000);
  }

  it('SC-3: allowed imports pass (import type allowances, cli -> claude-integration via dynamic import())', async () => {
    expect(await violations('allowed')).toEqual([]);
  }, 60_000);

  it('SC-3: the depcruise CLI exits non-zero on a violating fixture and zero on the allowed one', () => {
    const run = (fixture: string) =>
      spawnSync('pnpm', ['exec', 'depcruise', '--validate', '--config', configFile, '.'], { cwd: path.join(fixtures, fixture), encoding: 'utf8' });
    const bad = run('rule-10-no-circular');
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain('rule-10-no-circular');
    expect(run('allowed').status).toBe(0);
  }, 120_000);
});
