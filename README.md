# Loopwork

A workflow automation engine where **the canvas is the runtime**: watch items
stream along edges, scrub any loop iteration, fork a run from any step.

Focus: loop + graph engineering, fluid UI/UX. Apache-2.0.

Use it from a terminal (`loopwork`), from Claude Code (`/loopwork` opens a new
terminal window and a GUI window), or from Claude Desktop (MCP).

See [docs/PLAN.md](docs/PLAN.md), [CAPABILITY-MAP.md](CAPABILITY-MAP.md) and [docs/adr/](docs/adr/).

`packages/engine` (`@loopwork/engine`) is the in-process executor over `@loopwork/graph` and `@loopwork/eventlog`: plain
source→map→sink flows with backpressure, concurrency limits and fencing, plus `foreach` and `retry` frames (backoff, `emit-error`) with per-frame time budgets. `while`/`until`, resume and Postgres land in later slices.

## Local checks

Use Node 22 (`nvm use 22`; `package.json` requires `>=22`) with pnpm 12 (`corepack enable`, then `pnpm install`). Put the
repo-local tools on `PATH` (the scripts call bare `gitleaks`; `.tools/` is gitignored, and `.tools/bin` holds the
gitleaks 8.30.1 binary the same version CI installs):

```sh
export PATH="$PWD/.tools/bin:$PATH"
```

- `pnpm check:fast`: typecheck, lint, `gitleaks detect`, `scripts/floor-guard.sh`.
- `pnpm check:task`: `check:fast`, then `pnpm test --coverage`, then `depcruise --validate`. Known note: the bare `depcruise --validate` is a no-op until CONSTRAINTS.md is corrected to `depcruise . --validate`.
- `pnpm check:full`: `check:task`, then the Postgres and e2e tests, `semgrep` and `osv-scanner` (CI). `semgrep` and `osv-scanner` are not installed locally; CI runs them.
- `pnpm check:arch`: `depcruise . --validate`, the working architecture gate. CI runs it.

`pnpm test` runs the `unit` vitest project only (`*.pg.test.ts` and `*.e2e.test.ts` are separate projects). Use
`pnpm test --coverage`, not `pnpm test -- --coverage`: pnpm 12 forwards the literal `--`, which turns `--coverage` into a
file filter and silently skips coverage. With `--coverage` the run also enforces the changed-line coverage gate (changed
lines at least 80% covered). The floor guard and that gate diff against `$LOOPWORK_BASE_REF`, else `git merge-base HEAD main`.

### Postgres tests

`pnpm test:pg` needs a Postgres 16 and fails (it never skips) when `LOOPWORK_TEST_DATABASE_URL` is unset. With Docker:

```sh
docker compose -p loopwork-test -f docker-compose.test.yml up -d --wait
LOOPWORK_TEST_DATABASE_URL=postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test pnpm test:pg
docker compose -p loopwork-test -f docker-compose.test.yml down -v
```

The database listens on loopback port 55432 only and keeps its data on tmpfs. Always pass `-p loopwork-test` so `down -v` cannot touch another compose stack.

### CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`, on `ubuntu-24.04` with Node 22. Jobs: `fast` (typecheck, lint,
gitleaks, floor guard), `task` (`pnpm test --coverage` with the changed-line gate, then `pnpm check:arch`), `pg` (a `postgres:16`
service and `pnpm test:pg`), `e2e` (`pnpm test:e2e`; there are no e2e tests yet), `semgrep` and `osv-scanner`. The workflow has
not yet run on a hosted runner.
