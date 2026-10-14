import path from 'node:path';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// GM-9: packages/graph is browser-loadable. The lint rules (eslint.config.js) are the first line of defence, proved here
// against throwaway sources and against the real tree; the dependency-cruiser rule 1 (T06) is the second.
const root = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: root });
const BROWSER = 'graph is browser-loadable';
const GRAPH_FILE = 'packages/graph/src/throwaway.ts';

async function lint(code: string, file = GRAPH_FILE): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(`${code}\n`, { filePath: path.join(root, file) });
  return results.flatMap((r) => r.messages);
}
const errors = (messages: Linter.LintMessage[], ruleId: string): Linter.LintMessage[] =>
  messages.filter((m) => m.ruleId === ruleId && m.severity === 2);

beforeAll(async () => {
  await lint('export const warm = 1;'); // first call loads the typescript-eslint config
}, 60_000);

describe('GM-9: packages/graph has no node: imports', () => {
  it('GM-9: packages/graph has no node: imports (a node: import is an error naming the reason, the real tree has none)', async () => {
    const fs = errors(await lint("import 'node:fs';"), 'no-restricted-imports');
    expect(fs).toHaveLength(1);
    expect(fs[0]?.message).toContain(BROWSER);

    const results = await eslint.lintFiles(['packages/graph']);
    const files = results.map((r) => path.relative(root, r.filePath));
    expect(files).toContain('packages/graph/src/index.ts'); // the glob really covers the package, so zero errors is not vacuous
    expect(files.some((f) => f.startsWith('packages/graph/test/'))).toBe(true);
    expect(results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${path.relative(root, r.filePath)}: ${m.message}`))).toEqual([]);
  }, 120_000);

  it('GM-9: a bare builtin such as worker_threads is an error too', async () => {
    const m = errors(await lint("import 'worker_threads';"), 'no-restricted-imports');
    expect(m).toHaveLength(1);
    expect(m[0]?.message).toContain(BROWSER);
  });

  it('GM-9: a dynamic import of a node: module is reported by no-restricted-syntax', async () => {
    const m = errors(await lint("export const load = () => import('node:fs');"), 'no-restricted-syntax');
    expect(m).toHaveLength(1);
    expect(m[0]?.message).toContain(BROWSER);
  });

  it('GM-9: a relative import such as ./util/index.js is fine', async () => {
    expect(await lint("import { x } from './util/index.js';\nexport const y = x;")).toEqual([]);
  });

  it('GM-9: a triple-slash reference to node types is an error', async () => {
    const m = errors(await lint('/// <reference types="node" />\nexport const x = 1;'), '@typescript-eslint/triple-slash-reference');
    expect(m).toHaveLength(1);
  });
});
