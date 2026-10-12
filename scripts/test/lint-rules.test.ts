import path from 'node:path';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: root });

// Forbidden snippets are assembled from fragments so this file itself never contains them as source text.
const ANY = ['an', 'y'].join('');
const tsComment = (directive: string, rest = ''): string => `// @ts-${directive}${rest}\nexport const x: number = 's';`;
const eslintDisable = ['eslint', 'disable-next-line'].join('-');
const log = (receiver: string): string => `${receiver}.log('x');`;

const BROWSER = 'graph is browser-loadable';
const GRAPH = 'packages/graph/src/a.ts';
const LIB = 'packages/eventlog/src/a.ts';

async function lint(file: string, code: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(`${code}\n`, { filePath: path.join(root, file) });
  return results.flatMap((r) => r.messages);
}

/** Error-severity messages for one rule (optionally whose text contains `text`). */
function errors(messages: Linter.LintMessage[], ruleId: string, text = ''): Linter.LintMessage[] {
  return messages.filter((m) => m.ruleId === ruleId && m.severity === 2 && m.message.includes(text));
}

beforeAll(async () => {
  await lint(GRAPH, 'export const warm = 1;'); // first call loads the typescript-eslint config
}, 60_000);

describe('SC-1 lint rules (characterises the real eslint.config.js)', () => {
  it('SC-1: lint bans explicit any', async () => {
    const m = await lint(LIB, `export const x: ${ANY} = 1;`);
    expect(errors(m, '@typescript-eslint/no-explicit-any')).toHaveLength(1);
  });

  it('SC-1: lint bans console in packages but not in scripts/*.mjs', async () => {
    for (const file of [GRAPH, LIB, 'packages/windows/test/a.test.ts']) {
      expect(errors(await lint(file, log('console')), 'no-console'), file).toHaveLength(1);
    }
    expect(await lint('scripts/a.mjs', log('console'))).toEqual([]);
  });

  it('SC-1: lint bans process.stdout and globalThis.console in packages', async () => {
    const stdout = await lint(LIB, "process.stdout.write('x');");
    expect(errors(stdout, 'no-restricted-properties', 'library code never writes stdout')).toHaveLength(1);
    const viaGlobal = await lint(LIB, log('globalThis.console'));
    expect(errors(viaGlobal, 'no-restricted-properties', 'library code never writes stdout')).toHaveLength(1);
    expect(await lint(LIB, "process.stderr.write('x');")).toEqual([]);
  });

  it('SC-1: lint bans ts-ignore and bare or short ts-expect-error, allows a described ts-expect-error', async () => {
    const rule = '@typescript-eslint/ban-ts-comment';
    expect(errors(await lint(LIB, tsComment('ignore')), rule)).toHaveLength(1);
    expect(errors(await lint(LIB, tsComment('expect-error')), rule)).toHaveLength(1);
    expect(errors(await lint(LIB, tsComment('expect-error', ': short')), rule)).toHaveLength(1);
    expect(errors(await lint(LIB, tsComment('expect-error', ': deliberate type mismatch for the test')), rule)).toHaveLength(0);
  });

  it('SC-1: lint rejects eslint-disable comments (noInlineConfig) and still reports the rule', async () => {
    const m = await lint(LIB, `// ${eslintDisable} no-console\n${log('console')}`);
    expect(m.filter((x) => x.ruleId === null && x.severity === 1 && x.message.includes('noInlineConfig'))).toHaveLength(1);
    expect(errors(m, 'no-console')).toHaveLength(1);
  });

  it('SC-1: lint keeps node builtins out of packages/graph (static imports)', async () => {
    for (const source of ['node:fs', 'node:test', 'fs', 'path', 'fs/promises', 'worker_threads', 'timers/promises']) {
      const m = await lint(GRAPH, `import '${source}';`);
      expect(errors(m, 'no-restricted-imports', BROWSER), source).toHaveLength(1);
    }
    const named = await lint(GRAPH, "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;");
    expect(errors(named, 'no-restricted-imports', BROWSER)).toHaveLength(1);
    const reexport = await lint(GRAPH, "export * from 'crypto';");
    expect(errors(reexport, 'no-restricted-imports', BROWSER)).toHaveLength(1);
    const typeOnly = await lint(GRAPH, "import type { Stats } from 'fs';\nexport type S = Stats;");
    expect(errors(typeOnly, 'no-restricted-imports', BROWSER)).toHaveLength(1);
  });

  it('SC-1: lint allows relative imports in graph and node builtins elsewhere', async () => {
    expect(await lint(GRAPH, "import { a } from './util/index.js';\nexport const b = a;")).toEqual([]);
    expect(await lint(GRAPH, "import { a } from '../path/x.js';\nexport const b = a;")).toEqual([]);
    expect(await lint(LIB, "import 'node:fs';")).toEqual([]);
  });

  it('SC-1: lint bans non-relative dynamic import in graph but allows relative ones', async () => {
    const dyn = await lint(GRAPH, "export const m = await import('node:fs');");
    expect(errors(dyn, 'no-restricted-syntax', BROWSER)).toHaveLength(1);
    expect(await lint(GRAPH, "export const m = await import('./x.js');")).toEqual([]);
  });

  it('SC-1: lint bans the process global and triple-slash references in graph', async () => {
    const proc = await lint(GRAPH, 'export const cwd = process.cwd();');
    expect(errors(proc, 'no-restricted-globals', BROWSER)).toHaveLength(1);
    const builtin = await lint(GRAPH, "export const m = process.getBuiltinModule('fs');");
    expect(errors(builtin, 'no-restricted-globals', BROWSER)).toHaveLength(1);

    const rule = '@typescript-eslint/triple-slash-reference';
    for (const attr of ['types="node"', 'lib="dom"', 'path="./x.d.ts"']) {
      expect(errors(await lint(GRAPH, `/// <reference ${attr} />\nexport const x = 1;`), rule), attr).toHaveLength(1);
    }
    expect(await lint(GRAPH, 'export const x = 1;')).toEqual([]);
  });

  it('SC-1: lint applies no-undef to scripts/*.mjs only', async () => {
    expect(errors(await lint('scripts/a.mjs', 'fooBar();'), 'no-undef')).toHaveLength(1);
    expect(await lint('scripts/a.mjs', "fetch('x');\nsetImmediate(() => {});\nprocess.exit(0);")).toEqual([]);
    expect(await lint('scripts/a.ts', 'export type T = Record<string, number>;\nexport const x: T = {};')).toEqual([]);
  });
});
