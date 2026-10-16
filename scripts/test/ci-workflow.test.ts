import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const workflowRel = '.github/workflows/ci.yml';

// The workflow is checked as text (no YAML dependency), in the same spirit as compose.test.ts. Every check is a small
// helper that returns a list of problems, so the meta-test at the bottom can prove each helper rejects a hostile
// sample; an empty list means "clean". Helpers take the workflow text (or one job's lines), never the file path.

function readWorkflow(): string {
  const file = path.join(root, workflowRel);
  if (!existsSync(file)) throw new Error(`${workflowRel} is missing: SC-7 requires the CI workflow`);
  return readFileSync(file, 'utf8');
}

const lines = (text: string): string[] => text.split(/\r?\n/);
const indentOf = (l: string): number => l.length - l.trimStart().length;
const isBlankOrComment = (l: string): boolean => /^\s*(#|$)/.test(l);
/** Drops a trailing ` # comment`. Only used on YAML structure lines, never on `run:` script bodies. */
const stripComment = (l: string): string => l.replace(/\s+#.*$/, '').trimEnd();
const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, '$2');
const active = (ls: string[]): string[] => ls.filter((l) => !isBlankOrComment(l)).map(stripComment);

/** The lines under top-level `jobs:`, split per job id by indentation. */
function jobsOf(text: string): Map<string, string[]> {
  const all = lines(text);
  const start = all.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const jobs = new Map<string, string[]>();
  if (start < 0) return jobs;
  let jobIndent = -1;
  let current: string[] | undefined;
  for (const l of all.slice(start + 1)) {
    if (isBlankOrComment(l)) {
      current?.push(l);
      continue;
    }
    const n = indentOf(l);
    if (n === 0) break; // next top-level key ends the jobs map
    if (jobIndent < 0) jobIndent = n;
    const id = n === jobIndent ? /^\s*["']?([\w-]+)["']?:\s*(#.*)?$/.exec(l)?.[1] : undefined;
    if (id) {
      current = [];
      jobs.set(id, current);
    } else {
      current?.push(l);
    }
  }
  return jobs;
}

/** The steps of one job, each as its own list of lines. */
function stepsOf(job: string[]): string[][] {
  const ls = active(job);
  const at = ls.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (at < 0) return [];
  const steps: string[][] = [];
  let itemIndent = -1;
  for (const l of ls.slice(at + 1)) {
    if (itemIndent < 0) itemIndent = indentOf(l);
    if (indentOf(l) < itemIndent) break;
    if (indentOf(l) === itemIndent && l.trimStart().startsWith('- ')) steps.push([l]);
    else steps.at(-1)?.push(l);
  }
  return steps;
}

/** Every `run:` script of a job or workflow, whole (comments inside a script are kept: Actions interpolates them too). */
function runBodies(ls: string[]): string[] {
  const out: string[] = [];
  ls.forEach((l, i) => {
    const m = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(l);
    if (!m) return;
    const keyCol = (m[1] ?? '').length;
    const body = /^[|>][+-]?\d*\s*(#.*)?$/.test(m[2] ?? '') ? [] : [m[2] ?? ''];
    for (const next of ls.slice(i + 1)) {
      if (next.trim() !== '' && indentOf(next) < keyCol) break;
      body.push(next);
    }
    out.push(body.join('\n'));
  });
  return out;
}

/** Whether some script runs `cmd` as a whole command (not as a prefix of `pnpm test:pgx`, not as part of another word). */
function runsCommand(scripts: string[], cmd: string): boolean {
  const re = new RegExp(`(?:^|[\\s/&;|"'])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`, 'm');
  return scripts.some((s) => re.test(s));
}

// --- SC-7 pins ---------------------------------------------------------------------------------------------------

const pinnedAction = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/; // owner/repo[/path]@sha, also reusable workflows
const pinnedDocker = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;

/** Every `uses:` value (steps, flow mappings, reusable workflows) that is neither a local `./` path nor a full-SHA pin. */
function unpinnedUses(text: string): string[] {
  const refs = active(lines(text)).flatMap((l) => {
    const m = /(?:^\s*(?:-\s+)?|[{,]\s*)uses:\s*(\S+?)\s*(?:[,}].*)?$/.exec(l);
    return m?.[1] ? [unquote(m[1])] : [];
  });
  const bad = refs.filter((r) => !r.startsWith('./') && !pinnedAction.test(r) && !pinnedDocker.test(r));
  return refs.length === 0 ? ['no uses: found at all'] : bad;
}

/** Normalised entries of each `permissions:` block: `['contents: read']`, `['write-all']`, ... */
function permissionBlocks(ls: string[]): { indent: number; entries: string[] }[] {
  const all = active(ls);
  const out: { indent: number; entries: string[] }[] = [];
  all.forEach((l, i) => {
    const m = /^(\s*)permissions:\s*(.*)$/.exec(l);
    if (!m) return;
    const indent = (m[1] ?? '').length;
    const inline = (m[2] ?? '').replace(/^\{\s*|\s*\}$/g, '').trim();
    if (inline !== '') return void out.push({ indent, entries: inline.split(/\s*,\s*/) });
    const body: string[] = [];
    for (const next of all.slice(i + 1)) {
      if (indentOf(next) <= indent) break;
      body.push(next.trim());
    }
    out.push({ indent, entries: body });
  });
  return out;
}

const readOnlyContents = (b: { entries: string[] }): boolean => b.entries.length === 1 && b.entries[0] === 'contents: read';

function permissionProblems(text: string): string[] {
  const problems: string[] = [];
  const top = permissionBlocks(lines(text)).filter((b) => b.indent === 0);
  if (top.length !== 1 || !top.every(readOnlyContents)) {
    problems.push(`top-level permissions must be exactly "contents: read", found ${JSON.stringify(top.map((b) => b.entries))}`);
  }
  const jobs = jobsOf(text);
  if (jobs.size === 0) problems.push('no jobs found');
  for (const [id, job] of jobs) {
    for (const b of permissionBlocks(job).filter((p) => !readOnlyContents(p))) {
      problems.push(`job ${id} sets permissions ${JSON.stringify(b.entries)}`);
    }
  }
  return problems;
}

// --- SC-7 injection and triggers ---------------------------------------------------------------------------------

/** `${{ ... }}` over attacker-controlled data inside a `run:` script (it belongs in `env:`), and the `pull_request_target` trigger. */
function injectionProblems(text: string): string[] {
  const problems = lines(text)
    .filter((l) => !isBlankOrComment(l) && /pull_request_target/.test(l))
    .map(() => 'uses pull_request_target');
  for (const script of runBodies(lines(text))) {
    const expr = /\$\{\{[^}]*\b(github\.event|github\.head_ref|github\.ref_name)\b[^}]*\}\}/.exec(script);
    if (expr) problems.push(`run script interpolates ${expr[0]}`);
  }
  return problems;
}

// --- SC-7 pg service, Node and checkout --------------------------------------------------------------------------

/** Items of every `ports:` list in the given lines, block style (`- "x"`) or flow style (`['x', 'y']`). */
function servicePorts(ls: string[]): string[] {
  const all = active(ls);
  return all.flatMap((l, i) => {
    const m = /^(\s*)ports:\s*(.*)$/.exec(l);
    if (!m) return [];
    const inline = (m[2] ?? '').trim();
    if (inline.startsWith('[')) return inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean);
    const items: string[] = [];
    for (const next of all.slice(i + 1)) {
      if (indentOf(next) < (m[1] ?? '').length || !next.trimStart().startsWith('- ')) break;
      items.push(unquote(next.trimStart().slice(2)));
    }
    return items;
  });
}

/** `docker run`-style publishing smuggled in through a service's `options:`. */
const publishesViaOptions = (ls: string[]): boolean => active(ls).some((l) => /^\s*options:.*(\s-p\b|--publish\b)/.test(l));

function nodeProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [id, job] of jobsOf(text)) {
    const steps = stepsOf(job);
    const setups = steps.filter((s) => s.some((l) => /\buses:\s*["']?actions\/setup-node@/.test(l)));
    if (runBodies(active(job)).some((s) => /\bpnpm\b/.test(s)) && setups.length === 0) problems.push(`job ${id} runs pnpm without setup-node`);
    for (const s of setups) {
      const v = s.map((l) => /\bnode-version:\s*["']?([^"'\s]+)/.exec(l)?.[1]).find(Boolean);
      if (!v || !/^22(\.|$)/.test(v)) problems.push(`job ${id} setup-node node-version is ${String(v)}, expected 22`);
    }
  }
  return problems;
}

function checkoutProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [id, job] of jobsOf(text)) {
    const checkouts = stepsOf(job).filter((s) => s.some((l) => /\buses:\s*["']?actions\/checkout@/.test(l)));
    if (checkouts.length === 0) problems.push(`job ${id} has no actions/checkout step`);
    for (const s of checkouts) {
      if (!s.some((l) => /(?:^|[{,])\s*fetch-depth:\s*["']?0["']?\s*(?:[,}]|$)/.test(l))) problems.push(`job ${id} checkout lacks fetch-depth: 0`);
    }
  }
  return problems;
}

// --- tests -------------------------------------------------------------------------------------------------------

const job = (jobs: Map<string, string[]>, id: string): string[] => {
  const j = jobs.get(id);
  if (!j) throw new Error(`${workflowRel} has no job "${id}" (found: ${[...jobs.keys()].join(', ') || 'none'})`);
  return j;
};

describe('ci workflow (SC-7)', () => {
  it('SC-7: every uses: is pinned to a 40-hex SHA', () => {
    expect(unpinnedUses(readWorkflow())).toEqual([]);
  });

  it('SC-7: permissions is contents: read at top level and no job widens it', () => {
    expect(permissionProblems(readWorkflow())).toEqual([]);
  });

  it('SC-7: workflow runs gitleaks, semgrep, osv-scanner, depcruise and pg tests', () => {
    const text = readWorkflow();
    const jobs = jobsOf(text);
    const scriptsOf = (id: string): string[] => runBodies(job(jobs, id));
    const want: [string, string[]][] = [
      ['fast', ['pnpm typecheck', 'pnpm lint', 'gitleaks detect --redact --no-banner', 'scripts/floor-guard.sh']],
      ['task', ['pnpm test --coverage', 'pnpm check:arch']],
      ['pg', ['pnpm test:pg']],
      ['e2e', ['pnpm test:e2e']],
      ['semgrep', ['semgrep scan --config p/default --config p/typescript --error']],
      ['osv-scanner', ['osv-scanner scan source -r .']],
    ];
    const missing = want.flatMap(([id, cmds]) => cmds.filter((c) => !runsCommand(scriptsOf(id), c)).map((c) => `${id}: ${c}`));
    expect(missing).toEqual([]);

    const all = runBodies(lines(text));
    expect(all.some((s) => /pnpm test -- --coverage/.test(s))).toBe(false); // silently skips coverage in pnpm 12
    expect(all.some((s) => /\bdepcruise\s+--validate/.test(s))).toBe(false); // bare form is a silent no-op
  });

  it('SC-7: the pg service publishes only 127.0.0.1:55432:5432', () => {
    const text = readWorkflow();
    const pg = job(jobsOf(text), 'pg');
    expect(servicePorts(lines(text))).toEqual(['127.0.0.1:55432:5432']); // anywhere in the workflow
    expect(servicePorts(pg)).toEqual(['127.0.0.1:55432:5432']); // and it is the pg job that has it
    expect(publishesViaOptions(pg)).toBe(false);
    expect(active(pg).join('\n')).toMatch(/LOOPWORK_TEST_DATABASE_URL:\s*["']?postgres:\/\/loopwork:loopwork@127\.0\.0\.1:55432\/loopwork_test["']?\s*$/m);
  });

  it('SC-7: no pull_request_target and no untrusted github.event interpolation in run steps', () => {
    expect(injectionProblems(readWorkflow())).toEqual([]);
  });

  it('SC-7: Node 22 and fetch-depth 0', () => {
    const text = readWorkflow();
    expect(nodeProblems(text)).toEqual([]);
    expect(checkoutProblems(text)).toEqual([]);
    const jobs = jobsOf(text);
    for (const id of ['fast', 'task']) {
      expect(active(job(jobs, id)).join('\n'), `${id} must set LOOPWORK_BASE_REF`).toMatch(/\bLOOPWORK_BASE_REF:/);
    }
  });

  // The helpers above are only worth trusting if they reject bad input. Each one gets a hostile sample here, plus a
  // clean one, so a helper that always returns [] (and would make the real tests pass vacuously) fails this test.
  it('SC-7: every helper rejects a hostile sample and accepts a clean one', () => {
    const sha = 'a'.repeat(40);
    const uses = (...refs: string[]): string => `jobs:\n  j:\n    steps:\n${refs.map((r) => `      - uses: ${r}`).join('\n')}\n`;

    expect(unpinnedUses(uses(`actions/checkout@${sha} # v4.2.2`, './.github/actions/x', `org/r/.github/workflows/w.yml@${sha}`))).toEqual([]);
    for (const bad of ['actions/checkout@v4', 'actions/checkout@main', `actions/checkout@${'a'.repeat(39)}`, `actions/checkout@${'a'.repeat(41)}`, `actions/checkout@${'A'.repeat(40)}`, 'org/r/.github/workflows/w.yml@v1', 'docker://alpine:3']) {
      expect(unpinnedUses(uses(`actions/checkout@${sha}`, bad)), bad).toEqual([bad]);
    }
    expect(unpinnedUses('jobs:\n  j:\n    steps:\n      - { uses: actions/checkout@v4 }\n')).toEqual(['actions/checkout@v4']);
    expect(unpinnedUses('jobs: {}\n')).not.toEqual([]);

    const wf = (top: string, jobPerms = ''): string => `${top}\njobs:\n  j:\n    runs-on: x\n${jobPerms}    steps:\n      - run: echo\n`;
    expect(permissionProblems(wf('permissions:\n  contents: read'))).toEqual([]);
    expect(permissionProblems(wf('permissions:\n  contents: read', '    permissions:\n      contents: read\n'))).toEqual([]);
    for (const [top, perms] of [
      ['name: x', ''],
      ['permissions: write-all', ''],
      ['permissions:\n  contents: write', ''],
      ['permissions:\n  contents: read\n  id-token: write', ''],
      ['permissions:\n  contents: read', '    permissions:\n      contents: write\n'],
      ['permissions:\n  contents: read', '    permissions:\n      contents: read\n      pull-requests: write\n'],
      ['permissions:\n  contents: read', '    permissions: write-all\n'],
      ['permissions:\n  contents: read', '    permissions: { contents: read, packages: write }\n'],
    ] as const) {
      expect(permissionProblems(wf(top, perms)), `${top} / ${perms}`).not.toEqual([]);
    }

    const run = (script: string, env = ''): string => `jobs:\n  j:\n    steps:\n      - ${env}run: ${script}\n`;
    const title = '${{ github.event.pull_request.title }}';
    expect(injectionProblems('on: [pull_request]\n' + run('|\n          echo "$T"', ''))).toEqual([]);
    expect(injectionProblems('jobs:\n  j:\n    steps:\n      - env:\n          T: ' + title + '\n        run: echo "$T"\n')).toEqual([]);
    expect(injectionProblems(run(`echo "${title}"`))).not.toEqual([]);
    expect(injectionProblems(run(`|\n          echo ok\n          echo "${title}"`))).not.toEqual([]);
    expect(injectionProblems(run('|\n          # ' + title + '\n          echo ok'))).not.toEqual([]);
    expect(injectionProblems(run('echo ${{ github.head_ref }}'))).not.toEqual([]);
    expect(injectionProblems('on:\n  pull_request_target:\n')).not.toEqual([]);
    expect(injectionProblems('on: [pull_request_target]\n')).not.toEqual([]);

    const ports = (p: string): string => `services:\n  pg:\n    image: postgres:16\n${p}`;
    expect(servicePorts(lines(ports('    ports:\n      - "127.0.0.1:55432:5432"\n')))).toEqual(['127.0.0.1:55432:5432']);
    expect(servicePorts(lines(ports("    ports: ['127.0.0.1:55432:5432']\n")))).toEqual(['127.0.0.1:55432:5432']);
    expect(servicePorts(lines(ports('    ports:\n      - 55432:5432\n')))).toEqual(['55432:5432']);
    expect(servicePorts(lines(ports('    ports:\n      - "127.0.0.1:55432:5432"\n      - "5432:5432"\n')))).toHaveLength(2);
    expect(servicePorts(lines(ports('')))).toEqual([]);
    expect(publishesViaOptions(lines(ports('    options: --health-cmd x -p 5432:5432\n')))).toBe(true);
    expect(publishesViaOptions(lines(ports('    options: --publish 5432:5432\n')))).toBe(true);
    expect(publishesViaOptions(lines(ports('    options: --health-cmd pg_isready\n')))).toBe(false);

    expect(runsCommand(['pnpm test:pg'], 'pnpm test:pg')).toBe(true);
    expect(runsCommand(['pnpm install\npnpm test --coverage'], 'pnpm test --coverage')).toBe(true);
    expect(runsCommand(['pnpm test:pgx'], 'pnpm test:pg')).toBe(false);
    expect(runsCommand(['pnpm lint:fix'], 'pnpm lint')).toBe(false);
    expect(runsCommand(['echo hello'], 'pnpm test:pg')).toBe(false);
    expect(runsCommand(['mypnpm lint'], 'pnpm lint')).toBe(false);
    expect(runBodies(lines('      - name: pnpm test:pg\n        run: echo hi\n')).some((s) => runsCommand([s], 'pnpm test:pg'))).toBe(false);
    expect(runBodies(lines('      # run: pnpm test:pg\n')) ).toEqual([]);

    const step = (extra: string): string => `jobs:\n  j:\n    steps:\n      - uses: actions/checkout@${sha}\n${extra}      - uses: actions/setup-node@${sha}\n        with:\n          node-version: 22\n      - run: pnpm install\n`;
    expect(nodeProblems(step(''))).toEqual([]);
    expect(nodeProblems(step('').replace('node-version: 22', "node-version: '22'"))).toEqual([]);
    expect(nodeProblems(step('').replace('node-version: 22', 'node-version: 20'))).not.toEqual([]);
    expect(nodeProblems(step('').replace('node-version: 22', 'node-version: 220'))).not.toEqual([]);
    expect(nodeProblems(step('').replace(/ {6}- uses: actions\/setup-node[\s\S]*?22\n/, ''))).not.toEqual([]);
    expect(checkoutProblems(step('').replace(`checkout@${sha}\n`, `checkout@${sha}\n        with:\n          fetch-depth: 0\n`))).toEqual([]);
    expect(checkoutProblems(step(''))).not.toEqual([]);
    expect(checkoutProblems(step('').replace(`checkout@${sha}\n`, `checkout@${sha}\n        with:\n          fetch-depth: 1\n`))).not.toEqual([]);
    expect(checkoutProblems('jobs:\n  j:\n    steps:\n      - run: echo\n')).not.toEqual([]);
  });
});
