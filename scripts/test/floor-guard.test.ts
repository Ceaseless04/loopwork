// SC-2: tool test of the shell script scripts/floor-guard.sh. It uses spawnSync on purpose and runs in the `unit`
// vitest project, so that `pnpm test` alone proves the floor rules (CONSTRAINTS.md "Floor") are enforced.
//
// The forbidden strings live only in the *.diff fixtures under scripts/test/fixtures/floor-guard/ (a .ts file that
// contained them would trip the guard and lint itself). Inputs built at run time are assembled from fragments.
// Temp repos and message files live under os.tmpdir(): the repo-wide test-file walker in sc-1-workspace.test.ts must
// never see directories appear or vanish inside the repo tree.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'scripts/floor-guard.sh');
const fixtures = path.join(import.meta.dirname, 'fixtures/floor-guard');
const scratch = mkdtempSync(path.join(tmpdir(), 'floor-guard-test-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function guard(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string | undefined> } = {}): Run {
  const r = spawnSync(script, args, {
    cwd: opts.cwd ?? scratch,
    input: opts.input,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, LOOPWORK_BASE_REF: undefined, ...opts.env },
  });
  if (r.error) throw r.error; // e.g. ENOENT while scripts/floor-guard.sh does not exist or is not executable
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const fixture = (name: string): string => path.join(fixtures, `${name}.diff`);
const runFixture = (name: string, extra: string[] = []): Run => guard(['--diff-file', fixture(name), ...extra]);

interface Violation {
  rule: string;
  file: string;
  line: number;
}

/** Parses the `floor-guard: <rule-id> <file>:<line>` lines of stderr. */
function violations(stderr: string): Violation[] {
  return stderr.split('\n').flatMap((l) => {
    const m = /^floor-guard: ([a-z-]+) (.+):(\d+)$/.exec(l);
    return m ? [{ rule: m[1] ?? '', file: m[2] ?? '', line: Number(m[3]) }] : [];
  });
}

/** `[file, line]`; a bare `file` means "any line" (removed lines and deleted files have no added-line number). */
type Loc = [file: string, line?: number];

function expectFails(r: Run, rule: string, locs: Loc[]): void {
  expect(r.status, r.stderr).not.toBe(0);
  expect(r.stdout).toBe('');
  const found = violations(r.stderr);
  expect(new Set(found.map((v) => v.rule))).toEqual(new Set([rule]));
  for (const [file, line] of locs) {
    const hit = found.some((v) => v.file === file && (line === undefined || v.line === line));
    expect(hit, `expected "floor-guard: ${rule} ${file}:${line ?? '<n>'}" in:\n${r.stderr}`).toBe(true);
  }
  if (locs.every(([, line]) => line !== undefined)) {
    const key = (file: string, line: number | undefined): string => `${file}:${line}`;
    expect(new Set(found.map((v) => key(v.file, v.line)))).toEqual(new Set(locs.map(([f, l]) => key(f, l))));
  }
}

function expectPasses(r: Run): void {
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('');
  expect(violations(r.stderr)).toEqual([]);
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const at = (file: string, lines: number[]): Loc[] => lines.map((l): Loc => [file, l]);

function commitMessage(name: string, text: string): string {
  const file = path.join(scratch, `${name}.msg`);
  writeFileSync(file, text);
  return file;
}

const SUPPRESSION_LOCS: Loc[] = [
  ...at('packages/graph/src/suppress.ts', [2, 4, 6, 8, 9, 10, 11, 12, 13]),
  ...at('scripts/suppress.mjs', [2, 4, 6]),
  ...at('packages/eventlog/src/mod.ts', [4]),
];

const REASON = 'Fix flaky append test\n\nTest-Change-Reason: upstream timer API changed, assertion moved to EL-2\n';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

function makeRepo(name: string): string {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'packages/graph/src'), { recursive: true });
  writeFileSync(path.join(dir, 'packages/graph/src/base.ts'), 'export const base = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

describe('SC-2 floor-guard.sh', () => {
  it('SC-2: floor-guard.sh exists and is executable', () => {
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();
    expect(readFileSync(script, 'utf8').startsWith('#!')).toBe(true);
  });

  it('SC-2: exits 0 on a clean tree', () => {
    const repo = makeRepo('clean-tree');
    const r = guard([], { cwd: repo });
    expectPasses(r);
    expect(r.stderr).toBe('');
  });

  it('SC-2: exits 0 on a clean diff and stays within the 5 s edit-loop budget', () => {
    const t0 = Date.now();
    const r = runFixture('clean');
    const elapsed = Date.now() - t0;
    expectPasses(r);
    expect(elapsed).toBeLessThan(5000);
  });

  it('SC-2: exits 0 on an empty diff read from stdin', () => {
    expectPasses(guard(['--diff-file', '-'], { input: '' }));
  });

  it('SC-2: reads the diff from stdin when given -', () => {
    const r = guard(['--diff-file', '-'], { input: readFileSync(fixture('suppression'), 'utf8') });
    expectFails(r, 'suppression', SUPPRESSION_LOCS);
  });

  it('SC-2: default mode checks tracked changes vs LOOPWORK_BASE_REF plus untracked files, and falls back to merge-base with main', () => {
    const repo = makeRepo('default-mode');
    const base = git(repo, 'rev-parse', 'HEAD');
    const ignore = `// @ts-${'ignore'}`;
    const stub = `throw new Error('Not ${'implemented'}');`;
    const log = `${'console'}.log('x');`;

    writeFileSync(path.join(repo, 'packages/graph/src/committed.ts'), `export const ok = 1;\n${ignore}\nexport const n: number = 's';\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    writeFileSync(path.join(repo, 'packages/graph/src/base.ts'), `export const base = 1;\n${stub}\n`);
    mkdirSync(path.join(repo, 'packages/runtime/src'), { recursive: true });
    writeFileSync(path.join(repo, 'packages/runtime/src/fresh.ts'), `export const x = 1;\n${log}\n`);

    const vsBase = guard([], { cwd: repo, env: { LOOPWORK_BASE_REF: base } });
    expect(vsBase.status, vsBase.stderr).not.toBe(0);
    expect(vsBase.stdout).toBe('');
    const found = violations(vsBase.stderr).map((v) => `${v.rule} ${v.file}:${v.line}`).sort();
    expect(found).toEqual(
      ['stdout packages/runtime/src/fresh.ts:2', 'stub packages/graph/src/base.ts:2', 'suppression packages/graph/src/committed.ts:2'].sort(),
    );

    const vsMain = guard([], { cwd: repo });
    expect(vsMain.status, vsMain.stderr).not.toBe(0);
    expect(vsMain.stdout).toBe('');
    const foundMain = violations(vsMain.stderr).map((v) => `${v.rule} ${v.file}:${v.line}`).sort();
    expect(foundMain).toEqual(['stdout packages/runtime/src/fresh.ts:2', 'stub packages/graph/src/base.ts:2'].sort());
  });

  it('SC-2: suppression rule fails every banned suppression comment in .ts and .mjs files', () => {
    const r = runFixture('suppression');
    expectFails(r, 'suppression', SUPPRESSION_LOCS);
  });

  it('SC-2: stub rule fails Not-implemented throws, empty catch blocks and a TODO standing for the implementation', () => {
    const r = runFixture('stub');
    expectFails(r, 'stub', [...at('packages/engine/src/stub.ts', [2, 5, 8, 11]), ...at('scripts/stub.mjs', [1])]);
  });

  it('SC-2: skipped-test rule fails .skip, .todo, xit and xdescribe', () => {
    const r = runFixture('skipped-test');
    expectFails(r, 'skipped-test', at('packages/eventlog/test/skipped.test.ts', range(2, 7)));
  });

  it('SC-2: skipped-test rule fails a deleted *.test.ts', () => {
    expectFails(runFixture('skipped-test-deleted'), 'skipped-test', [['packages/eventlog/test/z.test.ts']]);
  });

  it('SC-2: skipped-test rule fails net-removed expect( lines in a test that stayed', () => {
    expectFails(runFixture('skipped-test-removed-expect'), 'skipped-test', [['packages/eventlog/test/z.test.ts']]);
  });

  it('SC-2: secret rule fails database URLs with credentials, passwords, private keys and cloud keys in any file type', () => {
    const r = runFixture('secret');
    expectFails(r, 'secret', [
      ['packages/eventlog/src/conn.ts', 1],
      ['deploy/config.yaml', 2],
      ['docs/setup.md', 3],
      ['packages/service/test/key.pem', 1],
      ['scripts/deploy.mjs', 1],
    ]);
  });

  it('SC-2: stdout rule fails console.log/info/debug, any process.stdout access and globalThis.console under packages/*/src', () => {
    const r = runFixture('stdout');
    expectFails(r, 'stdout', [...at('packages/runtime/src/out.ts', range(2, 8)), ...at('packages/windows/src/out.ts', [1])]);
  });

  it('SC-2: stdout rule fails console aliasing (const c = console, const { log } = console)', () => {
    expectFails(runFixture('stdout-alias'), 'stdout', at('packages/runtime/src/alias.ts', [1, 2]));
  });

  it('SC-2: bind rule fails the all-interfaces IPv4 address, the IPv6 wildcard and host options other than loopback', () => {
    expectFails(runFixture('bind'), 'bind', at('packages/ui-server/src/server.ts', range(3, 8)));
  });

  it('SC-2: constraints-weakened rule fails a removed line in CONSTRAINTS.md', () => {
    expectFails(runFixture('constraints-removed'), 'constraints-weakened', [['CONSTRAINTS.md']]);
  });

  it('SC-2: constraints-weakened rule fails a changed line in CONSTRAINTS.md', () => {
    expectFails(runFixture('constraints-changed'), 'constraints-weakened', [['CONSTRAINTS.md']]);
  });

  it('SC-2: constraints-weakened rule fails a new row under Exceptions', () => {
    expectFails(runFixture('constraints-exception'), 'constraints-weakened', [['CONSTRAINTS.md', 94]]);
  });

  it('SC-2: must pass @ts-expect-error with a reason', () => {
    expectPasses(runFixture('ts-expect-error-reason'));
  });

  it('SC-2: must pass docs that only mention the forbidden words', () => {
    expectPasses(runFixture('md-mentions'));
  });

  it('SC-2: must pass pure additions to CONSTRAINTS.md outside Exceptions', () => {
    expectPasses(runFixture('constraints-addition'));
  });

  it('SC-2: must pass loopback binds', () => {
    expectPasses(runFixture('bind-ok'));
  });

  // The documented Postgres test database URL carries credentials by design (a throwaway local container on a
  // loopback port, see the pg test docs); it is the one explicit allowlist entry of the secret rule.
  it('SC-2: must pass the documented test database URL', () => {
    expectPasses(runFixture('test-db-url'));
  });

  it('SC-2: must pass process.stderr in library code and console output in scripts/ and apps/', () => {
    expectPasses(runFixture('stdout-allowed'));
  });

  it('SC-2: must pass a test edit that keeps the number of expect( lines', () => {
    expectPasses(runFixture('test-edit-balanced'));
  });

  it('SC-2: skipped-test rule passes with a non-empty Test-Change-Reason in the commit message', () => {
    const msg = ['--commit-msg-file', commitMessage('reason', REASON)];
    expectPasses(runFixture('skipped-test', msg));
    expectPasses(runFixture('skipped-test-deleted', msg));
    expectPasses(runFixture('skipped-test-removed-expect', msg));
  });

  it('SC-2: skipped-test rule still fails with an empty or missing Test-Change-Reason', () => {
    const empty = ['--commit-msg-file', commitMessage('empty-reason', 'Fix tests\n\nTest-Change-Reason:   \n')];
    const none = ['--commit-msg-file', commitMessage('no-reason', 'Fix tests\n\nNothing to see here.\n')];
    for (const extra of [empty, none]) {
      expectFails(runFixture('skipped-test', extra), 'skipped-test', at('packages/eventlog/test/skipped.test.ts', range(2, 7)));
      expectFails(runFixture('skipped-test-deleted', extra), 'skipped-test', [['packages/eventlog/test/z.test.ts']]);
    }
  });

  it('SC-2: a Test-Change-Reason does not excuse other rules', () => {
    const msg = ['--commit-msg-file', commitMessage('reason-other', REASON)];
    expectFails(runFixture('suppression', msg), 'suppression', SUPPRESSION_LOCS);
    expectFails(runFixture('constraints-removed', msg), 'constraints-weakened', [['CONSTRAINTS.md']]);
  });
});

// Real git state (temp repos under os.tmpdir()): the guard must fail closed and see every file git reports.
describe('SC-2 floor-guard.sh against real git state', () => {
  const IGNORE = `// @ts-${'ignore'}`;
  const LOG = `${'console'}.log('x');`;
  const modes = ['tracked', 'untracked'] as const;

  /** A repo whose base commit lacks `rel` (untracked) or holds it unmodified (tracked); the working tree then holds `body` at line 2. */
  function repoWithFile(name: string, rel: string, mode: (typeof modes)[number], body: string): string {
    const repo = makeRepo(name);
    const file = path.join(repo, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    if (mode === 'tracked') {
      writeFileSync(file, 'export const a = 1;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'add');
    }
    writeFileSync(file, `export const a = 1;\n${body}\n`);
    return repo;
  }

  it('SC-2: fails closed (exit 2, floor-guard: error:) on an unresolvable base ref, with or without a violation', () => {
    const repo = makeRepo('bad-ref');
    for (const dirty of [false, true]) {
      if (dirty) writeFileSync(path.join(repo, 'packages/graph/src/base.ts'), `export const base = 1;\n${IGNORE}\n`);
      const r = guard([], { cwd: repo, env: { LOOPWORK_BASE_REF: 'deadbeef' } });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/^floor-guard: error: /m);
    }
  });

  it('SC-2: fails closed (exit 2) outside a git repository', () => {
    const dir = path.join(scratch, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    const r = guard([], { cwd: dir });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/^floor-guard: error: /m);
  });

  it('SC-2: scans paths with spaces (tracked-modified and untracked) with the correct file:line', () => {
    for (const mode of modes) {
      const a = repoWithFile(`space-a-${mode}`, 'scripts/with space.ts', mode, IGNORE);
      expectFails(guard([], { cwd: a, env: { LOOPWORK_BASE_REF: git(a, 'rev-parse', 'HEAD') } }), 'suppression', [['scripts/with space.ts', 2]]);
      const b = repoWithFile(`space-b-${mode}`, 'packages/graph/src/sp ace/a.ts', mode, LOG);
      expectFails(guard([], { cwd: b, env: { LOOPWORK_BASE_REF: git(b, 'rev-parse', 'HEAD') } }), 'stdout', [['packages/graph/src/sp ace/a.ts', 2]]);
    }
  });

  it('SC-2: scans non-ASCII paths (tracked-modified and untracked)', () => {
    for (const mode of modes) {
      const a = repoWithFile(`utf8-a-${mode}`, 'packages/graph/src/caf\u00e9.ts', mode, LOG);
      expectFails(guard([], { cwd: a, env: { LOOPWORK_BASE_REF: git(a, 'rev-parse', 'HEAD') } }), 'stdout', [['packages/graph/src/caf\u00e9.ts', 2]]);
      const b = repoWithFile(`utf8-b-${mode}`, 'scripts/\u00fc.mjs', mode, IGNORE);
      expectFails(guard([], { cwd: b, env: { LOOPWORK_BASE_REF: git(b, 'rev-parse', 'HEAD') } }), 'suppression', [['scripts/\u00fc.mjs', 2]]);
    }
  });

  it('SC-2: a rename is a delete plus an add: renaming CONSTRAINTS.md fails constraints-weakened', () => {
    const repo = makeRepo('rename-constraints');
    writeFileSync(path.join(repo, 'CONSTRAINTS.md'), '# Constraints\n\nFloor rules live here.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'constraints');
    git(repo, 'mv', 'CONSTRAINTS.md', 'C2.md');
    expectFails(guard([], { cwd: repo, env: { LOOPWORK_BASE_REF: git(repo, 'rev-parse', 'HEAD') } }), 'constraints-weakened', [['CONSTRAINTS.md']]);
  });

  it('SC-2: renaming a *.test.ts to a non-test name fails skipped-test', () => {
    const repo = makeRepo('rename-test');
    writeFileSync(path.join(repo, 'packages/graph/src/a.test.ts'), "expect(1).toBe(1);\nexpect(2).toBe(2);\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'test');
    git(repo, 'mv', 'packages/graph/src/a.test.ts', 'packages/graph/src/a.check.ts');
    expectFails(guard([], { cwd: repo, env: { LOOPWORK_BASE_REF: git(repo, 'rev-parse', 'HEAD') } }), 'skipped-test', [['packages/graph/src/a.test.ts']]);
  });

  it('SC-2: renaming an unrelated file stays clean', () => {
    const repo = makeRepo('rename-clean');
    git(repo, 'mv', 'packages/graph/src/base.ts', 'packages/graph/src/base2.ts');
    expectPasses(guard([], { cwd: repo, env: { LOOPWORK_BASE_REF: git(repo, 'rev-parse', 'HEAD') } }));
  });

  it('SC-2: --diff-file / --commit-msg-file without a value is a usage error (exit 2), not a violation', () => {
    for (const flag of ['--diff-file', '--commit-msg-file']) {
      const r = guard([flag]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
      expect(violations(r.stderr)).toEqual([]);
    }
  });
});
