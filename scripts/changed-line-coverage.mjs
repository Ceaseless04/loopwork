// Changed-line coverage gate (CONSTRAINTS.md "Coverage": changed lines >= 80% covered).
//
//   node scripts/changed-line-coverage.mjs [--lcov coverage/lcov.info] [--base <ref>] [--threshold 80]
//
// Intersects the lines added since the base (tracked changes, staged and unstaged, plus untracked files as fully added)
// with the executable lines (lcov `DA` records) of the report. Base: --base, else $LOOPWORK_BASE_REF, else
// `git merge-base HEAD main`. Only files vitest measures are in the report (coverage.include in vitest.config.ts:
// packages/*/src/** and scripts/*.mjs); a changed file absent from lcov is ignored by design, a changed non-executable line
// likewise, while a measured file with an uncovered changed line fails.
// Exit 0 = threshold met, 1 = not met (uncovered file:line listed on stderr), 2 = usage, IO or git error (fails closed:
// a bad ref, a missing report or a git failure is never a pass).
// Every git call is hardened against user config and attributes (see gitDiffArgs) and runs from the repo top level.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** lcov text -> file -> line -> hits (DA records only). */
export function parseLcov(text) {
  const files = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const file = line.slice(3);
      cur = files.get(file) ?? new Map();
      files.set(file, cur);
    } else if (line.startsWith('DA:') && cur) {
      const [ln, hits] = line.slice(3).split(',');
      cur.set(Number(ln), (cur.get(Number(ln)) ?? 0) + Number(hits));
    } else if (line === 'end_of_record') cur = null;
  }
  return files;
}

/** `git diff -U0` text -> file (new path) -> added line numbers. Hunk line counts are followed, so content never reads as a header. */
export function parseAddedLines(diff) {
  const added = new Map();
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        if (file !== null) (added.get(file) ?? added.set(file, new Set()).get(file)).add(next);
        next++;
        newLeft--;
      } else if (line.startsWith('-')) oldLeft--;
      else if (!line.startsWith('\\')) {
        next++;
        oldLeft--;
        newLeft--;
      }
    } else if (line.startsWith('diff --git ')) file = null;
    else if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, ''); // git appends a TAB after names containing spaces
      file = name === '/dev/null' ? null : name.replace(/^b\//, '');
    } else {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        next = Number(m[2]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
      }
    }
  }
  return added;
}

/** Only changed lines that are executable (a DA record) in a measured file count. */
export function changedLineCoverage(lcov, added) {
  let covered = 0;
  let total = 0;
  const uncovered = new Map();
  for (const [file, lines] of added) {
    const hits = lcov.get(file);
    if (!hits) continue;
    for (const ln of [...lines].sort((a, b) => a - b)) {
      const h = hits.get(ln);
      if (h === undefined) continue;
      total++;
      if (h > 0) covered++;
      else uncovered.set(file, [...(uncovered.get(file) ?? []), ln]);
    }
  }
  return { covered, total, pct: total === 0 ? 100 : (covered * 100) / total, uncovered };
}

const USAGE = 'usage: changed-line-coverage.mjs [--lcov <file>] [--base <ref>] [--threshold <0-100>]';

function parseArgs(argv) {
  const opts = { lcov: 'coverage/lcov.info', base: undefined, threshold: '80' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !Object.hasOwn(opts, key)) throw new Error(`unknown option or argument: ${argv[i]}\n${USAGE}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}\n${USAGE}`);
    opts[key] = argv[i + 1];
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(opts.threshold);
  if (!m || Number(opts.threshold) > 100) throw new Error(`--threshold must be a number from 0 to 100, got "${opts.threshold}"`);
  // The threshold as an integer ratio, so the comparison has no floating point drift.
  return { ...opts, num: Number(m[1] + (m[2] ?? '')), den: 10 ** (m[2] ?? '').length };
}

function spawnGit(args, cwd) {
  const env = { ...process.env };
  delete env.GIT_DIFF_OPTS; // it overrides -U0 (the environment wins over the command line)
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Added lines only, unaffected by diff config (prefixes, context, colour, ext diff, renames) and attributes (-diff, textconv). */
const gitDiffArgs = (sha) => [
  '-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '-U0',
  '--src-prefix=a/', '--dst-prefix=b/', sha, '--',
];

/** argv, injectable deps -> exit code. */
export async function main(argv, deps = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    out = (s) => process.stdout.write(`${s}\n`),
    err = (s) => process.stderr.write(`${s}\n`),
    readFile = (p) => readFileSync(p, 'utf8'),
    git = (args) => spawnGit(args, cwd),
  } = deps;
  try {
    const { lcov: lcovPath, base, num, den } = parseArgs(argv);
    const lcov = parseLcov(await readFile(path.resolve(cwd, lcovPath)));
    const top = (await git(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    const g = async (args) => git(['-C', top, ...args]);
    const ref =
      base ??
      (env.LOOPWORK_BASE_REF ||
        (await g(['merge-base', 'HEAD', 'main']).catch(() => {
          throw new Error('no base: pass --base, set LOOPWORK_BASE_REF or create a main branch');
        })).trim());
    const sha = await g(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => {
      throw new Error(`bad base ref: ${ref}`);
    });
    const diff = await g(gitDiffArgs(sha.trim()));
    if (/^diff --git .*"/m.test(diff)) throw new Error('cannot scan a C-quoted path');
    const added = parseAddedLines(diff);
    for (const file of (await g(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
      const lines = lcov.get(file);
      if (lines) added.set(file, new Set(lines.keys()));
    }
    const { covered, total, pct, uncovered } = changedLineCoverage(lcov, added);
    out(`changed-line coverage: ${pct.toFixed(1)}% (${covered}/${total} changed executable lines, threshold ${num / den}%)`);
    if (covered * 100 * den >= num * total) return 0;
    err('changed-line-coverage: below threshold, uncovered changed lines:');
    for (const [file, lines] of uncovered) for (const ln of lines) err(`  ${file}:${ln}`);
    return 1;
  } catch (e) {
    err(`changed-line-coverage: error: ${e?.message ?? e}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
