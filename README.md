# Loopwork

A workflow automation engine where **the canvas is the runtime**: watch items
stream along edges, scrub any loop iteration, fork a run from any step.

Focus: loop + graph engineering, fluid UI/UX. Apache-2.0.

Use it from a terminal (`loopwork`), from Claude Code (`/loopwork` opens a new
terminal window and a GUI window), or from Claude Desktop (MCP).

See [docs/PLAN.md](docs/PLAN.md), [CAPABILITY-MAP.md](CAPABILITY-MAP.md) and [docs/adr/](docs/adr/).

## Local checks

Use Node 22 (`nvm use 22`) and put the repo-local tools on `PATH` (the scripts call bare `gitleaks`):

```sh
export PATH="$PWD/.tools/bin:$PATH"
```

- `pnpm check:fast`: typecheck, lint, `gitleaks detect`, `scripts/floor-guard.sh`.
- `pnpm check:task`: `check:fast`, then `pnpm test --coverage`, then `depcruise --validate`. Known note: the bare `depcruise --validate` is a no-op until CONSTRAINTS.md is corrected to `depcruise . --validate`.
- `pnpm check:full`: `check:task`, then the Postgres and e2e tests, `semgrep` and `osv-scanner` (CI).
- `pnpm check:arch`: `depcruise . --validate`, the working architecture gate. CI runs it.
