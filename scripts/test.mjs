// `pnpm test [--coverage]`: runs `vitest run <args exactly as forwarded>`; with --coverage (before any literal `--`,
// after which it is a vitest file filter) and a green run, also enforces the changed-line coverage threshold.
// Only `pnpm test --coverage` works: pnpm 12 forwards a literal `--`, so `pnpm test -- --coverage` is a file filter.
// With --coverage the only other option allowed is --project <name>: any other one (--coverage.*, --no-coverage,
// --config, --root, --watch, ...) could narrow, redirect, disable or stale the report the gate reads, so it is exit 2.
// coverage/lcov.info is deleted before vitest starts, so the gate never reads a report from an earlier run. File filters
// (positional arguments) are allowed: a partial run measures fewer lines as covered, so it can only fail, never pass.
// vitest is node_modules/.bin/vitest of the current directory: run from the repo top level (pnpm does); a direct
// `node scripts/test.mjs` from a subdirectory exits 127. SIGINT and SIGTERM are forwarded to vitest (no orphan).
// --watch without --coverage is the developer's choice, not a gate path.
import { spawn as spawnChild } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as changedLineCoverage } from './changed-line-coverage.mjs';

const vitest = (args) =>
  new Promise((resolve) => {
    const child = spawnChild(path.join(process.cwd(), 'node_modules', '.bin', 'vitest'), args, { stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward).on('SIGTERM', forward);
    child.on('error', (e) => {
      process.stderr.write(`test: cannot run vitest: ${e.message}\n`);
      resolve(127);
    });
    child.on('close', (code) => {
      process.off('SIGINT', forward).off('SIGTERM', forward);
      resolve(code ?? 1);
    });
  });

/** args -> exit code. */
export async function run(
  args,
  { spawn = vitest, main = changedLineCoverage, rm = (f) => rmSync(f, { force: true }), err = (s) => process.stderr.write(`${s}\n`) } = {},
) {
  const dashes = args.indexOf('--');
  const forwarded = dashes === -1 ? args : args.slice(0, dashes);
  const coverage = forwarded.some((a) => /^--(no-)?coverage([.=]|$)/.test(a));
  if (coverage) {
    const bad = forwarded.find((a) => a.startsWith('-') && a !== '--coverage' && a !== '--project' && !/^--project=[^-]/.test(a));
    if (bad !== undefined) {
      err(`test: ${bad} is not allowed with coverage (only --coverage, --project <name> and file filters are)`);
      return 2;
    }
    rm('coverage/lcov.info');
  }
  const code = await spawn(['run', ...args]);
  return code === 0 && coverage ? main([]) : code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
