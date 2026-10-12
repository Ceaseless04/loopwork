// `pnpm test [--coverage]`: runs `vitest run <args exactly as forwarded>`; with --coverage (before any literal `--`,
// after which it is a vitest file filter) and a green run, also enforces the changed-line coverage threshold.
// Only `pnpm test --coverage` works: pnpm 12 forwards a literal `--`, so `pnpm test -- --coverage` is a file filter.
import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as changedLineCoverage } from './changed-line-coverage.mjs';

const vitest = (args) =>
  new Promise((resolve) => {
    const child = spawnChild(path.join(process.cwd(), 'node_modules', '.bin', 'vitest'), args, { stdio: 'inherit' });
    child.on('error', (e) => {
      process.stderr.write(`test: cannot run vitest: ${e.message}\n`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

/** args -> exit code. */
export async function run(args, { spawn = vitest, main = changedLineCoverage } = {}) {
  const code = await spawn(['run', ...args]);
  const dashes = args.indexOf('--');
  const forwarded = dashes === -1 ? args : args.slice(0, dashes);
  return code === 0 && forwarded.includes('--coverage') ? main([]) : code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
