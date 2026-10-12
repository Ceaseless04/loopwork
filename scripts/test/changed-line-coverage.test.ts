// SC-5: tests of scripts/changed-line-coverage.mjs (changed-line coverage >= 80%, CONSTRAINTS.md "Coverage") and of the
// scripts/test.mjs wrapper behind `pnpm test --coverage`.
//
// Contract fixed by these tests (the brief names parseLcov / parseAddedLines / changedLineCoverage / main; the injection
// points below are this file's design, the implementation must match them):
//   main(argv, deps?) -> exit code. deps (all optional, defaults = real process): git(args) -> stdout (throws when git
//   fails), readFile(path) -> text (throws when missing), out(text) / err(text) sinks, env (replaces process.env for
//   LOOPWORK_BASE_REF), cwd (default process.cwd(); git runs from the repo top level found from it, a relative --lcov
//   is resolved against it). Untracked files count as fully added: every `DA` line of an untracked file is a changed line.
//   run(args, deps?) from scripts/test.mjs -> exit code. deps: spawn(vitestArgs) -> exit code (vitestArgs = ['run', ...args]),
//   main(argv) -> exit code. Both scripts must have no side effect when imported.
//
// The .mjs modules are loaded with a dynamic import and typed here, so this file typechecks (no allowJs) and fails with
// "cannot find module" until they exist. Real git runs only in temp repos under os.tmpdir() with every GIT_* variable
// stripped (a git hook would otherwise leak GIT_INDEX_FILE into the children).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Coverage {
  covered: number;
  total: number;
  pct: number;
  uncovered: Map<string, number[]>;
}

interface Deps {
  git?: (args: string[]) => string | Promise<string>;
  readFile?: (file: string) => string | Promise<string>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

interface LcMod {
  parseLcov(text: string): Map<string, Map<number, number>>;
  parseAddedLines(diff: string): Map<string, Set<number>>;
  changedLineCoverage(lcov: Map<string, Map<number, number>>, added: Map<string, Set<number>>): Coverage;
  main(argv: string[], deps?: Deps): Promise<number>;
}

interface WrapperMod {
  run(
    args: string[],
    deps?: { spawn?: (vitestArgs: string[]) => number | Promise<number>; main?: (argv: string[]) => number | Promise<number> },
  ): Promise<number>;
}

const root = path.resolve(import.meta.dirname, '../..');
const lcScript = path.join(root, 'scripts/changed-line-coverage.mjs');
const wrapperScript = path.join(root, 'scripts/test.mjs');
const load = async (): Promise<LcMod> => (await import(pathToFileURL(lcScript).href)) as LcMod;
const loadWrapper = async (): Promise<WrapperMod> => (await import(pathToFileURL(wrapperScript).href)) as WrapperMod;

const scratch = mkdtempSync(path.join(tmpdir(), 'clc-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const d = (...lines: string[]): string => `${lines.join('\n')}\n`;
const lines = (m: Map<string, Set<number>>, file: string): number[] => [...(m.get(file) ?? [])].sort((a, b) => a - b);

/** An lcov report: file -> line -> hits. */
const lcov = (files: Record<string, Record<number, number>>): string =>
  Object.entries(files)
    .map(([f, das]) => `TN:\nSF:${f}\n${Object.entries(das).map(([l, h]) => `DA:${l},${h}`).join('\n')}\nLF:1\nLH:1\nend_of_record\n`)
    .join('');

/** Lines 1..n all hit once, except the given ones (hits 0). */
const da = (n: number, uncovered: number[] = []): Record<number, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i): [number, number] => [i + 1, uncovered.includes(i + 1) ? 0 : 1]));

/** A `git diff -U0` block for a modified file. */
const mod = (file: string, ...body: string[]): string =>
  d(`diff --git a/${file} b/${file}`, 'index 1111111..2222222 100644', `--- a/${file}`, `+++ b/${file}`, ...body);

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 parseLcov', () => {
  it('SC-5: parseLcov reads DA records of several files as file -> line -> hits', async () => {
    const { parseLcov } = await load();
    const m = parseLcov(lcov({ 'packages/a/src/x.ts': { 1: 3, 2: 0, 7: 1 }, 'scripts/y.mjs': { 4: 0 } }));
    expect([...m.keys()].sort()).toEqual(['packages/a/src/x.ts', 'scripts/y.mjs']);
    expect([...(m.get('packages/a/src/x.ts') ?? [])]).toEqual([[1, 3], [2, 0], [7, 1]]);
    expect([...(m.get('scripts/y.mjs') ?? [])]).toEqual([[4, 0]]);
  });

  it('SC-5: parseLcov ignores every record except SF and DA, and accepts a DA checksum', async () => {
    const { parseLcov } = await load();
    const text = d(
      'TN:', 'SF:a.mjs', 'FN:1,f', 'FNF:1', 'FNH:1', 'FNDA:1,f', 'DA:2,1', 'DA:3,0,abc123==', 'LF:2', 'LH:1', 'BRDA:2,0,0,1', 'BRF:1', 'BRH:1', 'end_of_record',
    );
    expect([...(parseLcov(text).get('a.mjs') ?? [])]).toEqual([[2, 1], [3, 0]]);
  });

  it('SC-5: parseLcov keeps SF paths verbatim (spaces, non-ASCII, colon, comma)', async () => {
    const { parseLcov } = await load();
    const names = ['dir sp/café.mjs', 'packages/x/a:b.ts', 'scripts/a,b.mjs'];
    const m = parseLcov(lcov(Object.fromEntries(names.map((n, i): [string, Record<number, number>] => [n, { [i + 1]: 1 }]))));
    expect([...m.keys()].sort()).toEqual([...names].sort());
    expect(m.get('packages/x/a:b.ts')?.get(2)).toBe(1);
  });

  it('SC-5: parseLcov of an empty report is empty', async () => {
    const { parseLcov } = await load();
    expect(parseLcov('').size).toBe(0);
    expect(parseLcov('TN:\n').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 parseAddedLines', () => {
  it('SC-5: parseAddedLines expands -U0 hunk headers of every form over multiple hunks', async () => {
    const { parseAddedLines } = await load();
    const diff = mod(
      'a.mjs',
      '@@ -2,0 +3,2 @@', '+x', '+y',
      '@@ -10 +12 @@ function foo() {', '-old', '+new',
      '@@ -20,2 +21,3 @@', '-p', '-q', '+r', '+s', '+t',
      '@@ -30,2 +0,0 @@', '-gone', '-gone2',
      '@@ -40,0 +41,0 @@',
    );
    expect(lines(parseAddedLines(diff), 'a.mjs')).toEqual([3, 4, 12, 21, 22, 23]);
  });

  it('SC-5: parseAddedLines handles several files and a new file', async () => {
    const { parseAddedLines } = await load();
    const diff =
      mod('a.mjs', '@@ -1 +1 @@', '-a', '+b') +
      d('diff --git a/n.mjs b/n.mjs', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/n.mjs', '@@ -0,0 +1,3 @@', '+1', '+2', '+3') +
      d('diff --git a/one.mjs b/one.mjs', 'new file mode 100644', 'index 0000000..4444444', '--- /dev/null', '+++ b/one.mjs', '@@ -0,0 +1 @@', '+only');
    const m = parseAddedLines(diff);
    expect(lines(m, 'a.mjs')).toEqual([1]);
    expect(lines(m, 'n.mjs')).toEqual([1, 2, 3]);
    expect(lines(m, 'one.mjs')).toEqual([1]);
  });

  it('SC-5: parseAddedLines ignores deleted files and pure deletions', async () => {
    const { parseAddedLines } = await load();
    const diff =
      d('diff --git a/gone.mjs b/gone.mjs', 'deleted file mode 100644', 'index 5555555..0000000', '--- a/gone.mjs', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c') +
      mod('b.mjs', '@@ -4,2 +3,0 @@', '-x', '-y');
    const m = parseAddedLines(diff);
    expect(lines(m, 'gone.mjs')).toEqual([]);
    expect(lines(m, 'b.mjs')).toEqual([]);
  });

  it('SC-5: parseAddedLines keys a rename by its new path and ignores a pure rename', async () => {
    const { parseAddedLines } = await load();
    const diff =
      d('diff --git a/old.mjs b/new.mjs', 'similarity index 80%', 'rename from old.mjs', 'rename to new.mjs', 'index 6666666..7777777 100644', '--- a/old.mjs', '+++ b/new.mjs', '@@ -2 +2 @@', '-a', '+b') +
      d('diff --git a/same.mjs b/moved.mjs', 'similarity index 100%', 'rename from same.mjs', 'rename to moved.mjs') +
      mod('after.mjs', '@@ -1,0 +1 @@', '+z');
    const m = parseAddedLines(diff);
    expect(lines(m, 'new.mjs')).toEqual([2]);
    expect(lines(m, 'old.mjs')).toEqual([]);
    expect(lines(m, 'moved.mjs')).toEqual([]);
    expect(lines(m, 'after.mjs')).toEqual([1]);
  });

  it('SC-5: parseAddedLines handles paths with spaces (with and without the trailing tab git adds) and non-ASCII names', async () => {
    const { parseAddedLines } = await load();
    const diff = d(
      'diff --git a/dir/with space.mjs b/dir/with space.mjs', 'index 1111111..2222222 100644', '--- a/dir/with space.mjs\t', '+++ b/dir/with space.mjs\t', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/two sp ace.mjs b/two sp ace.mjs', 'index 1111111..2222222 100644', '--- a/two sp ace.mjs', '+++ b/two sp ace.mjs', '@@ -3,0 +4 @@', '+c',
      'diff --git a/scripts/café.mjs b/scripts/café.mjs', 'index 1111111..2222222 100644', '--- a/scripts/café.mjs', '+++ b/scripts/café.mjs', '@@ -1 +1 @@', '-a', '+b',
    );
    const m = parseAddedLines(diff);
    expect(lines(m, 'dir/with space.mjs')).toEqual([1]);
    expect(lines(m, 'two sp ace.mjs')).toEqual([4]);
    expect(lines(m, 'scripts/café.mjs')).toEqual([1]);
  });

  it('SC-5: parseAddedLines counts hunk lines, so a content line that looks like a file header does not switch files', async () => {
    const { parseAddedLines } = await load();
    const diff = mod(
      'a.mjs',
      '@@ -3,2 +3,3 @@',
      '--- a/decoy2.mjs',
      '-old line two',
      '+++ b/decoy.mjs',
      '+added two',
      '+added three',
      '\\ No newline at end of file',
    );
    const m = parseAddedLines(diff);
    expect(lines(m, 'a.mjs')).toEqual([3, 4, 5]);
    expect(lines(m, 'decoy.mjs')).toEqual([]);
    expect(lines(m, 'decoy2.mjs')).toEqual([]);
  });

  it('SC-5: parseAddedLines of an empty diff is empty', async () => {
    const { parseAddedLines } = await load();
    expect(parseAddedLines('').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 changedLineCoverage', () => {
  const L = (hits: Record<number, number>): Map<number, number> => new Map(Object.entries(hits).map(([k, v]): [number, number] => [Number(k), v]));
  const A = (...lns: number[]): Set<number> => new Set(lns);

  it('SC-5: 3 of 4 changed executable lines covered is 75% and names the uncovered line', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L(da(4, [4]))]]), new Map([['a.mjs', A(1, 2, 3, 4)]]));
    expect([r.covered, r.total, r.pct]).toEqual([3, 4, 75]);
    expect(r.uncovered).toEqual(new Map([['a.mjs', [4]]]));
  });

  it('SC-5: 4 of 5 is exactly 80%', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L(da(5, [2]))]]), new Map([['a.mjs', A(1, 2, 3, 4, 5)]]));
    expect([r.covered, r.total, r.pct]).toEqual([4, 5, 80]);
  });

  it('SC-5: 2 of 3 is two thirds', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L(da(3, [3]))]]), new Map([['a.mjs', A(1, 2, 3)]]));
    expect(r.pct).toBeCloseTo(66.67, 1);
  });

  it('SC-5: only changed lines count, however many other executable lines are uncovered', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L(da(10, [1, 2, 3, 4, 6, 7, 8, 9, 10]))]]), new Map([['a.mjs', A(5)]]));
    expect([r.covered, r.total, r.pct]).toEqual([1, 1, 100]);
    expect(r.uncovered.size).toBe(0);
  });

  it('SC-5: changed lines that are not executable (no DA record) are ignored', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L({ 1: 1, 4: 0 })]]), new Map([['a.mjs', A(1, 2, 3)]]));
    expect([r.covered, r.total, r.pct]).toEqual([1, 1, 100]);
  });

  it('SC-5: changed files that are absent from lcov (unmeasured) are ignored', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L({ 1: 1 })]]), new Map([['a.mjs', A(1)], ['docs/readme.md', A(1, 2, 3)], ['packages/x/test/t.test.ts', A(1)]]));
    expect([r.covered, r.total, r.pct]).toEqual([1, 1, 100]);
    expect(r.uncovered.size).toBe(0);
  });

  it('SC-5: any positive hit count is covered, zero is not, and uncovered lines are sorted per file', async () => {
    const { changedLineCoverage } = await load();
    const lc = new Map([['a.mjs', L({ 3: 0, 9: 0, 5: 42, 6: 1 })], ['b.mjs', L({ 1: 0 })]]);
    const r = changedLineCoverage(lc, new Map([['a.mjs', A(9, 3, 5, 6)], ['b.mjs', A(1)]]));
    expect([r.covered, r.total]).toEqual([2, 5]);
    expect(r.uncovered).toEqual(new Map([['a.mjs', [3, 9]], ['b.mjs', [1]]]));
  });

  it('SC-5: an empty change set is 100% with nothing to cover', async () => {
    const { changedLineCoverage } = await load();
    const r = changedLineCoverage(new Map([['a.mjs', L(da(3, [1, 2, 3]))]]), new Map());
    expect([r.covered, r.total, r.pct]).toEqual([0, 0, 100]);
    expect(r.uncovered.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 main with injected deps', () => {
  const SHA = { head: 'a'.repeat(40), env: 'b'.repeat(40), flag: 'c'.repeat(40), mergeBase: 'd'.repeat(40) };

  interface Fake {
    diff?: string;
    untracked?: string[];
    lcovText?: string;
    lcovFiles?: Record<string, string>;
    fail?: 'diff' | 'ls-files' | 'all';
    env?: Record<string, string | undefined>;
  }

  interface Outcome {
    code: number;
    out: string;
    err: string;
    all: string;
    calls: string[][];
    read: string[];
  }

  const sink = (): { push: (s: string) => void; text: () => string } => {
    const parts: string[] = [];
    return { push: (s) => parts.push(s.endsWith('\n') ? s : `${s}\n`), text: () => parts.join('') };
  };

  async function run(argv: string[], f: Fake = {}): Promise<Outcome> {
    const { main } = await load();
    const calls: string[][] = [];
    const read: string[] = [];
    const files = f.lcovFiles ?? { 'coverage/lcov.info': f.lcovText ?? '' };
    const refs: Record<string, string> = { HEAD: SHA.head, main: SHA.mergeBase, 'feature-x': SHA.flag, envref: SHA.env };
    const out = sink();
    const err = sink();
    const deps: Deps = {
      cwd: '/repo',
      env: f.env ?? {},
      out: out.push,
      err: err.push,
      readFile: (p) => {
        read.push(p);
        const key = Object.keys(files).find((k) => p === k || p.endsWith(`/${k}`));
        if (key === undefined) throw Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
        return files[key] ?? '';
      },
      git: (args) => {
        calls.push(args);
        if (f.fail === 'all') throw new Error('spawn git ENOENT');
        if (args.includes('--show-toplevel')) return '/repo\n';
        if (args.includes('merge-base')) return `${SHA.mergeBase}\n`;
        if (args.includes('--verify')) {
          const spec = [...args].reverse().find((a) => a.endsWith('^{commit}')) ?? args[args.length - 1] ?? '';
          const ref = spec.replace(/\^\{commit\}$/, '');
          const sha = refs[ref] ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : undefined);
          if (sha === undefined) throw new Error(`fatal: bad revision '${ref}'`);
          return `${sha}\n`;
        }
        if (args.includes('ls-files')) {
          if (f.fail === 'ls-files') throw new Error('ls-files failed');
          return (f.untracked ?? []).map((n) => `${n}\0`).join('');
        }
        if (args.includes('diff')) {
          if (f.fail === 'diff') throw new Error('diff failed');
          return f.diff ?? '';
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
    const code = await main(argv, deps);
    return { code, out: out.text(), err: err.text(), all: out.text() + err.text(), calls, read };
  }

  const diffCalls = (o: Outcome): string[][] => o.calls.filter((c) => c.includes('diff'));
  /** a.mjs lines 1..n changed, `uncovered` of them never run. */
  const changed = (n: number, uncovered: number[], file = 'a.mjs'): Fake => ({
    diff: mod(file, `@@ -1,${n} +1,${n} @@`, ...Array.from({ length: n }, () => '-x'), ...Array.from({ length: n }, () => '+y')),
    lcovText: lcov({ [file]: da(n, uncovered) }),
  });

  it('SC-5: 4 of 5 changed executable lines covered (exactly 80%) passes and prints the percentage', async () => {
    const o = await run([], changed(5, [3]));
    expect(o.code, o.all).toBe(0);
    expect(o.out).toMatch(/80(\.0+)?%/);
  });

  it('SC-5: 3 of 4 (75%) fails with exit 1 and lists every uncovered file:line', async () => {
    const o = await run([], { diff: mod('a.mjs', '@@ -1,2 +1,2 @@', '-a', '-b', '+a', '+b') + mod('b.mjs', '@@ -4,2 +4,2 @@', '-a', '-b', '+a', '+b'), lcovText: lcov({ 'a.mjs': da(2), 'b.mjs': { 4: 1, 5: 0 } }) });
    expect(o.code, o.all).toBe(1);
    expect(o.all).toContain('b.mjs:5');
    expect(o.all).not.toContain('a.mjs:');
    expect(o.all).toMatch(/75(\.0+)?%/);
    const two = await run([], changed(4, [2, 4]));
    expect(two.code).toBe(1);
    expect(two.all).toContain('a.mjs:2');
    expect(two.all).toContain('a.mjs:4');
  });

  it('SC-5: the threshold is compared exactly, without floating point drift (29 of 50 is 58%)', async () => {
    const o = await run(['--threshold', '58'], changed(50, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]));
    expect(o.code, o.all).toBe(0);
    const under = await run(['--threshold', '59'], changed(50, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]));
    expect(under.code).toBe(1);
  });

  it('SC-5: --threshold overrides the default of 80', async () => {
    expect((await run(['--threshold', '70'], changed(4, [4]))).code).toBe(0);
    expect((await run(['--threshold', '75'], changed(4, [4]))).code).toBe(0);
    expect((await run(['--threshold', '76'], changed(4, [4]))).code).toBe(1);
    expect((await run(['--threshold', '100'], changed(5, [3]))).code).toBe(1);
    expect((await run(['--threshold', '0'], changed(4, [1, 2, 3, 4]))).code).toBe(0);
    expect((await run(['--threshold', '100'], changed(4, []))).code).toBe(0);
  });

  it('SC-5: an empty diff and no untracked files pass', async () => {
    const o = await run([], { diff: '', untracked: [], lcovText: lcov({ 'a.mjs': da(3, [1, 2, 3]) }) });
    expect(o.code, o.all).toBe(0);
  });

  it('SC-5: non-executable changed lines and unmeasured files are ignored by main', async () => {
    const diff = mod('a.mjs', '@@ -1,0 +1,3 @@', '+a', '+b', '+c') + mod('docs/readme.md', '@@ -1,0 +1,9 @@', ...Array.from({ length: 9 }, () => '+t'));
    const o = await run([], { diff, lcovText: lcov({ 'a.mjs': { 1: 1, 7: 0 } }) });
    expect(o.code, o.all).toBe(0);
  });

  it('SC-5: an untracked file counts as fully added, through injected deps (no per-file git spawn)', async () => {
    const lc = lcov({ 'scripts/new one.mjs': { 1: 1, 2: 1, 3: 0, 5: 0 }, 'scripts/café.mjs': da(4), 'other.mjs': { 1: 0 } });
    const failing = await run([], { diff: '', untracked: ['scripts/new one.mjs', 'scripts/café.mjs', 'docs/n.md'], lcovText: lc });
    expect(failing.code, failing.all).toBe(1);
    expect(failing.all).toContain('scripts/new one.mjs:3');
    expect(failing.all).toContain('scripts/new one.mjs:5');
    expect(failing.all).not.toContain('other.mjs');
    expect(failing.calls.filter((c) => c.includes('ls-files'))).toHaveLength(1);

    const ok = await run([], { untracked: ['scripts/café.mjs', 'docs/n.md'], lcovText: lc });
    expect(ok.code, ok.all).toBe(0);
  });

  it('SC-5: untracked and tracked changes add up', async () => {
    const o = await run([], { diff: mod('a.mjs', '@@ -1 +1 @@', '-a', '+b'), untracked: ['n.mjs'], lcovText: lcov({ 'a.mjs': da(1), 'n.mjs': { 1: 1, 2: 0, 3: 0, 4: 1 } }) });
    expect(o.code, o.all).toBe(1);
    expect(o.all).toContain('n.mjs:2');
    expect(o.all).toContain('n.mjs:3');
    expect(o.all).toMatch(/60\.0%/);
    expect(o.all).toContain('3/5');
  });

  it('SC-5: base is --base, else LOOPWORK_BASE_REF, else the merge-base with main; git sees the resolved sha', async () => {
    const viaFlag = await run(['--base', 'feature-x'], { ...changed(1, []), env: { LOOPWORK_BASE_REF: 'envref' } });
    expect(viaFlag.code, viaFlag.all).toBe(0);
    expect(diffCalls(viaFlag)).toHaveLength(1);
    expect(diffCalls(viaFlag)[0]?.some((a) => a.includes(SHA.flag))).toBe(true);
    expect(viaFlag.calls.some((c) => c.includes('merge-base'))).toBe(false);

    const viaEnv = await run([], { ...changed(1, []), env: { LOOPWORK_BASE_REF: 'envref' } });
    expect(diffCalls(viaEnv)[0]?.some((a) => a.includes(SHA.env))).toBe(true);
    expect(viaEnv.calls.some((c) => c.includes('merge-base'))).toBe(false);

    const viaMergeBase = await run([], changed(1, []));
    const mb = viaMergeBase.calls.find((c) => c.includes('merge-base'));
    expect(mb).toEqual(expect.arrayContaining(['merge-base', 'HEAD', 'main']));
    expect(diffCalls(viaMergeBase)[0]?.some((a) => a.includes(SHA.mergeBase))).toBe(true);
  });

  it('SC-5: the git diff is hardened: -U0, no renames, no external diff or textconv, text, no colour, no quoted paths', async () => {
    const o = await run(['--base', 'feature-x'], changed(1, []));
    const diff = diffCalls(o)[0] ?? [];
    expect(diff).toEqual(expect.arrayContaining(['--no-renames', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '-U0']));
    expect(diff.join(' ')).toContain('core.quotePath=false');
    expect(diff.indexOf('-c')).toBeGreaterThan(-1);
    expect(o.calls.find((c) => c.includes('ls-files'))).toEqual(expect.arrayContaining(['--others', '--exclude-standard', '-z']));
  });

  it('SC-5: --lcov selects the report to read and the default is coverage/lcov.info', async () => {
    const custom = await run(['--lcov', 'out/x.info'], { lcovFiles: { 'out/x.info': lcov({ 'a.mjs': da(1) }) }, diff: mod('a.mjs', '@@ -1 +1 @@', '-a', '+b') });
    expect(custom.code, custom.all).toBe(0);
    expect(custom.read.every((p) => p.endsWith('out/x.info'))).toBe(true);
    const dflt = await run([], changed(1, []));
    expect(dflt.read.some((p) => p.endsWith('coverage/lcov.info'))).toBe(true);
  });

  it('SC-5: a missing lcov file is exit 2 with an error line, even when the diff is empty (never a silent pass)', async () => {
    for (const f of [changed(1, []), { diff: '' }]) {
      const o = await run([], { ...f, lcovFiles: {} });
      expect(o.code, o.all).toBe(2);
      expect(o.err).toMatch(/^changed-line-coverage: error: /m);
    }
  });

  it('SC-5: an unresolvable base ref is exit 2 and git diff is never run', async () => {
    for (const argv of [['--base', 'nope'], ['--base', '--stat'], ['--base', '--output=/tmp/x']]) {
      const o = await run(argv, changed(1, []));
      expect(o.code, o.all).toBe(2);
      expect(o.err).toMatch(/^changed-line-coverage: error: /m);
      expect(diffCalls(o)).toHaveLength(0);
    }
    for (const ref of ['nope', '--stat', '--output=/tmp/x']) {
      const o = await run([], { ...changed(1, []), env: { LOOPWORK_BASE_REF: ref } });
      expect(o.code, o.all).toBe(2);
      expect(diffCalls(o)).toHaveLength(0);
    }
  });

  it('SC-5: a git failure (diff, ls-files, or git missing) is exit 2 with an error line, never 0 or 1', async () => {
    for (const fail of ['diff', 'ls-files', 'all'] as const) {
      const o = await run(['--base', 'feature-x'], { ...changed(1, []), fail });
      expect(o.code, `${fail}: ${o.all}`).toBe(2);
      expect(o.err).toMatch(/^changed-line-coverage: error: /m);
    }
  });

  it('SC-5: usage errors are exit 2 (bad or missing option values, unknown options, stray arguments)', async () => {
    const bad = [
      ['--threshold'], ['--threshold', 'abc'], ['--threshold', ''], ['--threshold', '-1'], ['--threshold', '101'], ['--threshold', 'NaN'],
      ['--lcov'], ['--base'], ['--bogus'], ['stray'],
    ];
    for (const argv of bad) {
      const o = await run(argv, changed(4, []));
      expect(o.code, `${argv.join(' ')}: ${o.all}`).toBe(2);
      expect(o.err).toMatch(/^changed-line-coverage: /m);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 main against real git', () => {
  const saved: Record<string, string | undefined> = {};
  const touched = ['GIT_DIFF_OPTS', ...Object.keys(process.env).filter((k) => k.startsWith('GIT_'))];

  beforeAll(() => {
    for (const k of touched) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const cleanEnv = (): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  }

  const put = (repo: string, rel: string, body: string): void => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  /** n lines of `lineN();` */
  const body = (n: number, edit: Record<number, string> = {}): string => `${Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line${i + 1}();`).join('\n')}\n`;

  /** A repo on `main` with the given files committed. */
  function makeRepo(name: string, files: Record<string, string>, branch = 'main'): string {
    const dir = path.join(scratch, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', branch);
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base', '--allow-empty');
    return dir;
  }

  let counter = 0;
  /** Writes an lcov report outside the repo (an untracked lcov inside it would only be an unmeasured file). */
  const report = (files: Record<string, Record<number, number>>): string => {
    const file = path.join(scratch, `report-${counter++}.info`);
    writeFileSync(file, lcov(files));
    return file;
  };

  interface Outcome {
    code: number;
    all: string;
    err: string;
    out: string;
  }

  async function runMain(argv: string[], cwd: string, env: Record<string, string | undefined> = {}): Promise<Outcome> {
    const { main } = await load();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { cwd, env, out: (s) => out.push(s), err: (s) => err.push(`${s}\n`) });
    return { code, all: [...out, ...err].join('\n'), err: err.join(''), out: out.join('\n') };
  }

  const vsHead = (lc: string): string[] => ['--base', 'HEAD', '--lcov', lc];

  it('SC-5: a tracked change (staged and unstaged) is measured against the base working tree; unchanged uncovered lines are not counted', async () => {
    const repo = makeRepo('tracked', { 'scripts/a.mjs': body(5) });
    put(repo, 'scripts/a.mjs', body(5, { 2: 'changed2();' }));
    git(repo, 'add', 'scripts/a.mjs');
    put(repo, 'scripts/a.mjs', `${body(5, { 2: 'changed2();' })}line6();\n`);

    const fail = await runMain(vsHead(report({ 'scripts/a.mjs': da(6, [6]) })), repo);
    expect(fail.code, fail.all).toBe(1);
    expect(fail.all).toContain('scripts/a.mjs:6');
    expect(fail.all).not.toContain('scripts/a.mjs:2');

    const ok = await runMain(vsHead(report({ 'scripts/a.mjs': da(6, [1, 3, 4, 5]) })), repo);
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toMatch(/100(\.0+)?%/);
  });

  it('SC-5: a missing final newline marker in the diff does not confuse the parser', async () => {
    const repo = makeRepo('no-eol', { 'scripts/a.mjs': 'a();\nb();' });
    put(repo, 'scripts/a.mjs', 'a();\nb2();\nc();');
    const fail = await runMain(vsHead(report({ 'scripts/a.mjs': da(3, [3]) })), repo);
    expect(fail.code, fail.all).toBe(1);
    expect(fail.all).toContain('scripts/a.mjs:3');
    expect((await runMain(vsHead(report({ 'scripts/a.mjs': da(3) })), repo)).code).toBe(0);
  });

  it('SC-5: untracked files count as fully added, ignored files do not', async () => {
    const repo = makeRepo('untracked', { 'scripts/a.mjs': body(2), '.gitignore': 'ignored/\n' });
    put(repo, 'scripts/new.mjs', body(4));
    put(repo, 'ignored/x.mjs', body(3));
    const lc = report({ 'scripts/a.mjs': da(2), 'scripts/new.mjs': da(4, [3, 4]), 'ignored/x.mjs': da(3, [1, 2, 3]) });
    const fail = await runMain(vsHead(lc), repo);
    expect(fail.code, fail.all).toBe(1);
    expect(fail.all).toContain('scripts/new.mjs:3');
    expect(fail.all).toContain('scripts/new.mjs:4');
    expect(fail.all).not.toContain('ignored/x.mjs');
    const ok = await runMain(vsHead(report({ 'scripts/new.mjs': da(4), 'ignored/x.mjs': da(3, [1, 2, 3]) })), repo);
    expect(ok.code, ok.all).toBe(0);
  });

  it('SC-5: paths with spaces and non-ASCII names work, tracked-modified and untracked', async () => {
    for (const [i, name] of ['scripts/with space.mjs', 'scripts/café.mjs', 'scripts/ü ñ/日本 語.mjs'].entries()) {
      const repo = makeRepo(`names-${i}`, { [name]: body(3) });
      put(repo, name, body(4));
      const tracked = await runMain(vsHead(report({ [name]: da(4, [4]) })), repo);
      expect(tracked.code, tracked.all).toBe(1);
      expect(tracked.all).toContain(`${name}:4`);
      expect((await runMain(vsHead(report({ [name]: da(4, [1, 2, 3]) })), repo)).code).toBe(0);

      const fresh = `${path.dirname(name)}/fresh ${path.basename(name)}`;
      put(repo, fresh, body(4));
      const untracked = await runMain(vsHead(report({ [fresh]: da(4, [2, 4]) })), repo);
      expect(untracked.code, untracked.all).toBe(1);
      expect(untracked.all).toContain(`${fresh}:2`);
      expect(untracked.all).toContain(`${fresh}:4`);
    }
  });

  it('SC-5: diff.context, GIT_DIFF_OPTS and prefix or colour settings of the user cannot change the changed-line set', async () => {
    const repo = makeRepo('user-config', { 'scripts/a.mjs': body(10) });
    put(repo, 'scripts/a.mjs', body(10, { 5: 'changed5();' }));
    // line 5 is the only changed line and is covered; its neighbours are uncovered context that must not count
    const lc = report({ 'scripts/a.mjs': da(10, [1, 2, 3, 4, 6, 7, 8, 9, 10]) });
    for (const [key, value] of [['diff.context', '5'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always']] as const) {
      git(repo, 'config', key, value);
      const r = await runMain(vsHead(lc), repo);
      expect(r.code, `${key}: ${r.all}`).toBe(0);
      git(repo, 'config', '--unset', key);
    }
    process.env.GIT_DIFF_OPTS = '--unified=5';
    try {
      const r = await runMain(vsHead(lc), repo);
      expect(r.code, r.all).toBe(0);
      const bad = await runMain(vsHead(report({ 'scripts/a.mjs': da(10, [5]) })), repo);
      expect(bad.code, bad.all).toBe(1);
      expect(bad.all).toContain('scripts/a.mjs:5');
    } finally {
      delete process.env.GIT_DIFF_OPTS;
    }
  });

  it('SC-5: diff attributes (-diff, binary, a textconv driver) cannot hide an uncovered changed line', async () => {
    const lc = (): string => report({ 'scripts/a.mjs': da(3, [2]) });
    for (const [name, attrs, where] of [['minus-diff', '*.mjs -diff\n', 'worktree'], ['binary', '*.mjs binary\n', 'worktree'], ['textconv', '*.mjs diff=x\n', 'info']] as const) {
      const repo = makeRepo(`attr-${name}`, { 'scripts/a.mjs': body(3), ...(where === 'worktree' ? { '.gitattributes': attrs } : {}) });
      if (where === 'info') {
        put(repo, '.git/info/attributes', attrs);
        git(repo, 'config', 'diff.x.textconv', 'true');
      }
      put(repo, 'scripts/a.mjs', body(3, { 2: 'changed2();' }));
      const r = await runMain(vsHead(lc()), repo);
      expect(r.code, `${name}: ${r.all}`).toBe(1);
      expect(r.all).toContain('scripts/a.mjs:2');
    }
  });

  it('SC-5: a rename is a delete plus an add: every executable line of the new path counts', async () => {
    for (const edit of [true, false]) {
      const repo = makeRepo(`rename-${edit}`, { 'scripts/old.mjs': body(3) });
      git(repo, 'mv', 'scripts/old.mjs', 'scripts/new.mjs');
      if (edit) put(repo, 'scripts/new.mjs', body(3, { 2: 'changed2();' }));
      const r = await runMain(vsHead(report({ 'scripts/new.mjs': da(3, [1]) })), repo);
      expect(r.code, r.all).toBe(1);
      expect(r.all).toContain('scripts/new.mjs:1');
      expect((await runMain(vsHead(report({ 'scripts/new.mjs': da(3) })), repo)).code).toBe(0);
    }
  });

  it('SC-5: deleted files and deleted lines add no changed lines', async () => {
    const repo = makeRepo('deletions', { 'scripts/gone.mjs': body(3), 'scripts/a.mjs': body(5) });
    rmSync(path.join(repo, 'scripts/gone.mjs'));
    put(repo, 'scripts/a.mjs', body(5).replace('line2();\n', ''));
    const r = await runMain(vsHead(report({ 'scripts/gone.mjs': da(3, [1, 2, 3]), 'scripts/a.mjs': da(4, [1, 2, 3, 4]) })), repo);
    expect(r.code, r.all).toBe(0);
  });

  it('SC-5: files absent from lcov are ignored, a measured file with an uncovered changed line still fails', async () => {
    const repo = makeRepo('unmeasured', { 'scripts/a.mjs': body(2), 'docs/x.md': 'text\n', 'scripts/other.mjs': body(2) });
    put(repo, 'docs/x.md', 'changed\n');
    put(repo, 'scripts/other.mjs', body(2, { 1: 'c();' }));
    const lc = report({ 'scripts/a.mjs': da(2) });
    expect((await runMain(vsHead(lc), repo)).code).toBe(0);
    put(repo, 'scripts/a.mjs', body(2, { 2: 'c();' }));
    const r = await runMain(vsHead(report({ 'scripts/a.mjs': da(2, [2]) })), repo);
    expect(r.code, r.all).toBe(1);
  });

  it('SC-5: without a base the committed changes since the merge-base with main are measured, later main commits are not', async () => {
    const repo = makeRepo('merge-base', { 'scripts/a.mjs': body(3), 'scripts/m.mjs': body(2) });
    git(repo, 'switch', '-q', '-c', 'feat');
    git(repo, 'switch', '-q', 'main');
    put(repo, 'scripts/m.mjs', body(2, { 1: 'main1();' }));
    git(repo, 'commit', '-q', '-a', '-m', 'main moves on');
    git(repo, 'switch', '-q', 'feat');
    put(repo, 'scripts/a.mjs', body(3, { 3: 'feat3();' }));
    git(repo, 'commit', '-q', '-a', '-m', 'feature');
    const lc = report({ 'scripts/a.mjs': da(3, [3]), 'scripts/m.mjs': da(2, [1]) });
    const r = await runMain(['--lcov', lc], repo);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain('scripts/a.mjs:3');
    expect(r.all).not.toContain('scripts/m.mjs');
    expect((await runMain(['--lcov', report({ 'scripts/a.mjs': da(3), 'scripts/m.mjs': da(2, [1]) })], repo)).code).toBe(0);
  });

  it('SC-5: LOOPWORK_BASE_REF (injected env) is honoured, and a run from a subdirectory reports repo-relative paths', async () => {
    const repo = makeRepo('subdir', { 'scripts/a.mjs': body(3), 'scripts/sub/keep.txt': 'x\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    put(repo, 'scripts/a.mjs', body(3, { 1: 'c1();' }));
    git(repo, 'commit', '-q', '-a', '-m', 'second');
    put(repo, 'other/new.mjs', body(2)); // untracked, in another directory than the cwd
    const lc = report({ 'scripts/a.mjs': da(3, [1]), 'other/new.mjs': da(2, [2]) });
    const cwd = path.join(repo, 'scripts/sub');
    const r = await runMain(['--lcov', lc], cwd, { LOOPWORK_BASE_REF: base });
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain('scripts/a.mjs:1');
    expect(r.all).toContain('other/new.mjs:2');
    expect(r.all).not.toContain('scripts/sub/');
    const headOnly = await runMain(['--lcov', lc], cwd, { LOOPWORK_BASE_REF: 'HEAD' });
    expect(headOnly.code, headOnly.all).toBe(1);
    expect(headOnly.all).toContain('other/new.mjs:2');
    expect(headOnly.all).not.toContain('scripts/a.mjs');
  });

  it('SC-5: a relative --lcov (the default coverage/lcov.info) is read from the working directory', async () => {
    const repo = makeRepo('relative-lcov', { 'scripts/a.mjs': body(2) });
    put(repo, 'scripts/a.mjs', body(2, { 2: 'c();' }));
    mkdirSync(path.join(repo, 'coverage'));
    writeFileSync(path.join(repo, 'coverage/lcov.info'), lcov({ 'scripts/a.mjs': da(2, [2]) }));
    const r = await runMain(['--base', 'HEAD'], repo);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain('scripts/a.mjs:2');
  });

  it('SC-5: an unresolvable or option-looking base ref is exit 2 and never reaches git as a flag', async () => {
    const repo = makeRepo('bad-ref', { 'scripts/a.mjs': body(2) });
    put(repo, 'scripts/a.mjs', body(2, { 2: 'c();' }));
    const lc = report({ 'scripts/a.mjs': da(2, [2]) });
    const pwned = path.join(scratch, 'pwned.out');
    for (const ref of ['deadbeef', '--stat', `--output=${pwned}`]) {
      const viaFlag = await runMain(['--lcov', lc, '--base', ref], repo);
      expect(viaFlag.code, `--base ${ref}: ${viaFlag.all}`).toBe(2);
      expect(viaFlag.err).toMatch(/^changed-line-coverage: error: /m);
      const viaEnv = await runMain(['--lcov', lc], repo, { LOOPWORK_BASE_REF: ref });
      expect(viaEnv.code, `env ${ref}: ${viaEnv.all}`).toBe(2);
    }
    expect(existsSync(pwned)).toBe(false);
  });

  it('SC-5: exit 2 outside a git repository, with no main branch to take a merge-base with, and for a missing lcov file', async () => {
    const lonely = path.join(scratch, 'not-a-repo');
    mkdirSync(lonely, { recursive: true });
    const lc = report({ 'scripts/a.mjs': da(1) });
    const notRepo = await runMain(['--lcov', lc, '--base', 'HEAD'], lonely);
    expect(notRepo.code, notRepo.all).toBe(2);
    expect(notRepo.err).toMatch(/^changed-line-coverage: error: /m);

    const trunk = makeRepo('no-main', { 'scripts/a.mjs': body(1) }, 'trunk');
    const noMain = await runMain(['--lcov', lc], trunk);
    expect(noMain.code, noMain.all).toBe(2);
    expect(noMain.err).toMatch(/^changed-line-coverage: error: /m);

    const missing = await runMain(['--lcov', path.join(scratch, 'nope.info'), '--base', 'HEAD'], trunk);
    expect(missing.code, missing.all).toBe(2);
    expect(missing.err).toMatch(/^changed-line-coverage: error: /m);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 changed-line-coverage.mjs as a command', () => {
  function cli(args: string[], cwd: string, env: Record<string, string | undefined> = {}): { status: number | null; stdout: string; stderr: string } {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'LOOPWORK_BASE_REF' && k !== 'NODE_V8_COVERAGE'));
    const r = spawnSync(process.execPath, [lcScript, ...args], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...clean, ...env } });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function repoWithChange(name: string): { repo: string; lc: (uncovered: number[]) => string } {
    const repo = path.join(scratch, name);
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    const g = (...a: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        cwd: repo,
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      });
      expect(r.status, r.stderr).toBe(0);
    };
    g('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'scripts/a.mjs'), 'x();\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    writeFileSync(path.join(repo, 'scripts/a.mjs'), 'a();\nb();\nc();\nd();\ne();\n');
    return { repo, lc: (uncovered) => { const f = path.join(scratch, `${name}-${uncovered.join('-')}.info`); writeFileSync(f, lcov({ 'scripts/a.mjs': da(5, uncovered) })); return f; } };
  }

  it('SC-5: the command exits 0 and prints the percentage when the threshold is met', () => {
    const { repo, lc } = repoWithChange('cli-ok');
    const r = cli(['--lcov', lc([3]), '--base', 'HEAD'], repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/80(\.0+)?%/);
  });

  it('SC-5: the command exits 1 and lists file:line when the threshold is not met, and honours --threshold and LOOPWORK_BASE_REF', () => {
    const { repo, lc } = repoWithChange('cli-fail');
    const r = cli(['--lcov', lc([2, 3]), '--base', 'HEAD'], repo);
    expect(r.status, r.stderr).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('scripts/a.mjs:2');
    expect(`${r.stdout}${r.stderr}`).toContain('scripts/a.mjs:3');
    expect(cli(['--lcov', lc([2, 3]), '--base', 'HEAD', '--threshold', '60'], repo).status).toBe(0);
    expect(cli(['--lcov', lc([2, 3])], repo, { LOOPWORK_BASE_REF: 'HEAD' }).status).toBe(1);
  });

  it('SC-5: the command exits 2 with an error line on bad input (missing lcov, bad ref, bad option)', () => {
    const { repo, lc } = repoWithChange('cli-error');
    for (const args of [['--lcov', path.join(scratch, 'absent.info'), '--base', 'HEAD'], ['--lcov', lc([]), '--base', '--stat'], ['--lcov', lc([]), '--threshold', 'x']]) {
      const r = cli(args, repo);
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/^changed-line-coverage: /m);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SC-5 scripts/test.mjs', () => {
  const calls = (code: number | Promise<number>, mainCode: number | Promise<number> = 0): { spawned: string[][]; mains: string[][]; spawn: (a: string[]) => number | Promise<number>; main: (a: string[]) => number | Promise<number> } => {
    const spawned: string[][] = [];
    const mains: string[][] = [];
    return {
      spawned,
      mains,
      spawn: (a) => { spawned.push(a); return code; },
      main: (a) => { mains.push(a); return mainCode; },
    };
  };

  it('SC-5: pnpm test runs vitest with the forwarded arguments exactly as given and returns its exit code, without the coverage check', async () => {
    const { run } = await loadWrapper();
    const c = calls(0);
    expect(await run(['--project', 'unit'], c)).toBe(0);
    expect(c.spawned).toEqual([['run', '--project', 'unit']]);
    expect(c.mains).toHaveLength(0);

    const failing = calls(1);
    expect(await run(['--project', 'unit', '-t', 'a b'], failing)).toBe(1);
    expect(failing.spawned).toEqual([['run', '--project', 'unit', '-t', 'a b']]);
    expect(failing.mains).toHaveLength(0);

    const odd = calls(3);
    expect(await run([], odd)).toBe(3);
    expect(odd.spawned).toEqual([['run']]);
  });

  it('SC-5: with --coverage and vitest exit 0, the changed-line check runs and its exit code is returned', async () => {
    const { run } = await loadWrapper();
    for (const code of [0, 1, 2]) {
      const c = calls(0, code);
      expect(await run(['--project', 'unit', '--coverage'], c)).toBe(code);
      expect(c.spawned).toEqual([['run', '--project', 'unit', '--coverage']]);
      expect(c.mains).toHaveLength(1);
    }
    const first = calls(Promise.resolve(0), Promise.resolve(1));
    expect(await run(['--coverage', '--project', 'unit'], first)).toBe(1);
    expect(first.spawned).toEqual([['run', '--coverage', '--project', 'unit']]);
  });

  it('SC-5: with --coverage and a failing vitest, the vitest exit code is returned and the changed-line check is skipped', async () => {
    const { run } = await loadWrapper();
    for (const code of [1, 2, 130]) {
      const c = calls(code, 0);
      expect(await run(['--project', 'unit', '--coverage'], c)).toBe(code);
      expect(c.mains).toHaveLength(0);
    }
  });

  it('SC-5: a literal -- is forwarded untouched and a --coverage after it is a vitest file filter, not a request for coverage', async () => {
    const { run } = await loadWrapper();
    const c = calls(0, 1);
    expect(await run(['--project', 'unit', '--', '--coverage'], c)).toBe(0);
    expect(c.spawned).toEqual([['run', '--project', 'unit', '--', '--coverage']]);
    expect(c.mains).toHaveLength(0);
  });

  it('SC-5: the root test script goes through the wrapper and no package script relies on the -- form for coverage', () => {
    const scriptsOf = (dir: string): Record<string, string> =>
      (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    expect(scriptsOf(root)['test']).toBe('node scripts/test.mjs --project unit');
    const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, 'packages', e.name));
    for (const dir of [root, ...packages]) {
      for (const [name, command] of Object.entries(scriptsOf(dir))) {
        expect(command, `${path.basename(dir)}:${name}`).not.toMatch(/--\s+--coverage/);
      }
    }
  });

  describe('end to end in a throwaway project (real vitest, real git)', () => {
    /** A git repo with a one-function module, a vitest config with v8 lcov coverage, and the repo's node_modules linked in. */
    function project(name: string): string {
      const dir = path.join(scratch, name);
      mkdirSync(path.join(dir, 'dir sp'), { recursive: true });
      symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      const c = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir, encoding: 'utf8', env });
      expect(c.status, c.stderr).toBe(0);
      writeFileSync(path.join(dir, 'dir sp/m.mjs'), 'export function f(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n');
      writeFileSync(
        path.join(dir, 'vitest.config.mjs'),
        "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { coverage: { provider: 'v8', reporter: ['lcov', 'text-summary'], include: ['dir sp/*.mjs'] } } });\n",
      );
      return dir;
    }

    const testFile = (extra: string): string => `import { test, expect } from 'vitest';\nimport { f } from './dir sp/m.mjs';\ntest('f', () => {\n  expect(f(1)).toBe(1);\n${extra}});\n`;

    function wrapper(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
      const clean = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('VITEST') && k !== 'NODE_V8_COVERAGE' && k !== 'LOOPWORK_BASE_REF'),
      );
      const r = spawnSync(process.execPath, [wrapperScript, ...args], { cwd, encoding: 'utf8', timeout: 90_000, env: { ...clean, LOOPWORK_BASE_REF: 'HEAD' } });
      if (r.error) throw r.error;
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    it('SC-5: `test.mjs --coverage` runs coverage (lcov.info is written) and fails on an uncovered changed line, then passes once covered', () => {
      const dir = project('e2e-coverage');
      writeFileSync(path.join(dir, 'a.test.mjs'), testFile(''));
      const failing = wrapper(['--coverage'], dir);
      expect(existsSync(path.join(dir, 'coverage/lcov.info'))).toBe(true);
      expect(failing.status, `${failing.stdout}\n${failing.stderr}`).toBe(1);
      expect(`${failing.stdout}${failing.stderr}`).toContain('dir sp/m.mjs:5');

      writeFileSync(path.join(dir, 'a.test.mjs'), testFile('  expect(f(0)).toBe(2);\n'));
      const passing = wrapper(['--coverage'], dir);
      expect(passing.status, `${passing.stdout}\n${passing.stderr}`).toBe(0);
      expect(passing.stdout).toMatch(/100(\.0+)?%/);
    }, 120_000);

    it('SC-5: `test.mjs` without --coverage does not run the changed-line check, even with an uncovered change', () => {
      const dir = project('e2e-plain');
      writeFileSync(path.join(dir, 'a.test.mjs'), testFile(''));
      const r = wrapper([], dir);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(existsSync(path.join(dir, 'coverage/lcov.info'))).toBe(false);
      expect(`${r.stdout}${r.stderr}`).not.toContain('dir sp/m.mjs:5');
    }, 120_000);
  });
});
