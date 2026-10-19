# Constraints

Last reviewed: 2026-10-12 by the project owner. Written before any code exists (greenfield), so every command below
is installed by the scaffold task in the first handoff brief. Tightening this file is silent; loosening it is loud
(see "Guarding the bar").

## Floor (always enforced, blocks from day one, no setup beyond `scripts/floor-guard.sh`)

- No new suppression comments: `@ts-ignore`, `@ts-expect-error` without a reason, `eslint-disable`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`
- No unimplemented stubs: `throw new Error('Not implemented')`, empty `catch {}`, `TODO` standing where the implementation should be
- No skipped or deleted tests (`.skip`, `.todo`, `xit`, removed assertions) without a reason in the commit message
- No secrets in source, config, fixtures or docs. `DATABASE_URL` values and passwords are never committed
- Library code (`packages/*`) never writes to stdout (`console.log`, `process.stdout.write`): stdout belongs to the CLI and the MCP protocol
- Servers bind `127.0.0.1` only: no `0.0.0.0`, `::`, or `host:` options other than loopback
- This file does not get weakened to make a change pass

## Enforced with numbers

Where the "Starts" column says a date, the check **warns** until then and **blocks** after. Everything else blocks now.

| Dimension | Rule | Checked by | Runs at | Starts blocking |
|---|---|---|---|---|
| Floor | the seven rules above | `scripts/floor-guard.sh` (diff-scoped; adapted from the constraint skill's reference) | every edit, CI | now |
| Types | zero type errors | `pnpm typecheck` | every edit, CI | now |
| Lint | zero errors; `no-explicit-any`, `no-console` in `packages/*` | `pnpm lint` | every edit, CI | now |
| Secrets | none in source or history of the branch | `gitleaks detect --redact --no-banner` | every edit, CI | now |
| Coverage | changed lines ≥ 80% covered (new greenfield code, so no legacy excuse; config-only lines excluded) | `pnpm test --coverage` + diff intersection | task end, CI | 2026-10-26 |
| Architecture | module boundaries from `CAPABILITY-MAP.md`: see rules below | `depcruise --validate` (`.dependency-cruiser.cjs`) | task end, CI | 2026-10-26 |
| Security: code | no high findings | `semgrep scan --config p/default --config p/typescript --error` | CI | 2026-10-26 |
| Security: deps | nothing at high or above | `osv-scanner scan source -r .` | CI | 2026-10-26 |
| Accessibility | zero critical or serious axe violations on the GUI's launcher, run list and run view | `axe <local ui-server URL> --tags wcag2a,wcag2aa,wcag21aa` | CI (needs the UV-13 smoke harness) | 2026-10-26, or when UV-13 lands if later |
| Time per stage | edit loop ≤ 5 s on changed files; task end ≤ 90 s | the scripts below | always | now (a slow check moves to CI, it is not skipped) |

At least two of these are **external** (osv-scanner reads a vulnerability database, axe encodes WCAG); the rest are project-owned.

### Architecture rules (`.dependency-cruiser.cjs`)

Type-only imports (`import type`) are allowed where noted; "value import" means anything else.

1. `packages/graph`: no value or type imports of any other `@loopwork/*` package; no `node:*` imports (browser-loadable).
2. `packages/eventlog`: `import type` from `@loopwork/graph` only; no other `@loopwork/*`.
3. `packages/windows`: no `@loopwork/*` imports at all.
4. `packages/engine`: may import `graph` and `eventlog`; never `runtime`, `service`, `ui-server`, `mcp`, `apps/*`.
5. `packages/runtime`: may import `eventlog` and `engine`; never `service` or any front door.
6. `packages/service`: may import `graph`, `eventlog`, `engine`, `runtime`; never `ui-server`, `mcp`, `apps/*`, `integrations/*`.
7. **Front doors** (`packages/ui-server`, `packages/mcp`, `apps/cli`, `integrations/claude`): no value imports of `pg`, `@loopwork/engine`, `@loopwork/runtime`, `@loopwork/eventlog`. They use `@loopwork/service` (and `@loopwork/windows` for `cli`). Type-only imports of `graph`, `eventlog` and `service` types are fine.
8. `apps/ui-viewer`: value imports of `@loopwork/graph` only; type-only from `service`; no `node:*`; `fetch` only to same-origin `/api`.
9. `apps/cli` has **no static import** of `@loopwork/claude-integration` (dynamic `import()` only); `integrations/claude` may import cli types only.
10. No circular dependencies anywhere.

## Measured, not yet enforced (ratchet: must not get worse, tolerance 0.5%)

First measurement is recorded after the first merged module; until then "unrecorded" means the check is a no-op, not a pass.

| Metric | Today | Direction | Set by |
|---|---|---|---|
| Project line coverage | unrecorded | must not fall | first merge to the integration branch |
| `ui-viewer` bundle size (gz) | unrecorded | must not grow | first `ui-viewer` build |
| Gate wall time, 100k items | unrecorded (placeholder ≤ 300 s) | must not grow | first full `SPEC-exit-gate.md` XG-1 run |
| Gate peak worker RSS | unrecorded (placeholder ≤ 512 MB) | must not grow | same run |
| Gate throughput (items/s) | unrecorded | must not fall | same run |

When a number improves, update it in the same PR. When it drops, that is the finding; fix the code, not the number.

## Where checks run (scripts mirror this file; this file wins on any drift)

```json
{
  "scripts": {
    "check:fast": "pnpm typecheck && pnpm lint && gitleaks detect --redact --no-banner && scripts/floor-guard.sh",
    "check:task": "pnpm check:fast && pnpm test --coverage && depcruise --validate",
    "check:full": "pnpm check:task && pnpm test:pg && pnpm test:e2e && semgrep scan --config p/default --config p/typescript --error && osv-scanner scan source -r ."
  }
}
```
`check:fast` after each edit (changed files only), `check:task` when a task is declared done, `check:full` and axe in CI. Postgres-backed tests (`*.pg.test.ts`) and the e2e gate run in CI and in `/develop`'s `dev-tester` stage, not in the 90 s task-end budget.

## Guarding the bar

Review (and `dev-code-reviewer`) must flag any of these in a diff, with `git diff` against the branch point:
1. a threshold moved, a check removed from a stage, or a severity lowered in this file or in the scripts;
2. a test made easier: `.skip`, a deleted test file, assertions removed from a test that stayed;
3. a checker silenced (`@ts-ignore`, `eslint-disable`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`, `/* v8 ignore */`);
4. unfinished work: stubs that throw, empty `catch`, a `TODO` in place of an implementation;
5. a new row in Exceptions that was not discussed with the owner;
6. a change to `.dependency-cruiser.cjs` that adds an allowed import across a boundary above.

## Exceptions

None. Format when needed: `ID | rule | path | reason | owner | expires` (≤ 90 days).

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
