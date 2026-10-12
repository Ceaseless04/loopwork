---
mode: needs_implementation
title: Phase 1 foundation — scaffold + graph-model + window-launcher + event-log
branch: feat/phase1-foundation
base: 0d6c7bf81315394db5f7d4ec1fd6257df2ca39d0
default_branch: main
created_by: claude-code
---

## What
Stand up the pnpm/TypeScript monorepo with every check in `CONSTRAINTS.md` runnable, then implement the first three
modules of `CAPABILITY-MAP.md`'s build order that have no runtime upstream: `graph-model`, `window-launcher`, and
`event-log` (which type-imports `graph-model`). No engine, queue, service, CLI, MCP or GUI code in this brief.

## Why
Phase 1 of `docs/PLAN.md`. The scaffold makes the quality bar executable before any feature code exists; the three
modules are the foundation every later module builds on. The specs are the source of truth:
`SPEC-graph-model.md`, `SPEC-window-launcher.md`, `SPEC-event-log.md`. Where this brief and a spec differ, the spec wins.

## Acceptance criteria
Full text for every criterion is in the named spec; each ID must map to a named test (`it('GM-3: …')`).
- SC-1: `pnpm install`, `pnpm -r build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` pass on the workspace; vitest distinguishes `*.test.ts`, `*.pg.test.ts`, `*.e2e.test.ts` as in the capability map.
- SC-2: `scripts/floor-guard.sh` exits 0 on a clean tree and exits non-zero for each floor rule in `CONSTRAINTS.md` (suppression comment, stub/empty catch, skipped/deleted test, secret, stdout write in `packages/*`, non-loopback bind, weakened CONSTRAINTS.md); a test with fixture diffs proves each.
- SC-3: `.dependency-cruiser.cjs` encodes architecture rules 1–10 from `CONSTRAINTS.md`; a fixture violating each rule makes `depcruise --validate` fail.
- SC-4: `check:fast`, `check:task`, `check:full` exist in root `package.json` exactly as in `CONSTRAINTS.md`; `check:task` completes in under 90 s on this repo.
- SC-5: changed-line coverage (≥ 80%, lcov ∩ `git diff`) runs from `pnpm test --coverage` via `scripts/changed-line-coverage.mjs`; unit-tested.
- SC-6: `docker-compose.test.yml` (Postgres 16, port 55432, db `loopwork_test`, user/password `loopwork`) and `pnpm test:pg` work with `LOOPWORK_TEST_DATABASE_URL`.
- SC-7: `.github/workflows/ci.yml` runs `check:full` pieces (gitleaks, semgrep, osv-scanner, depcruise, pg tests); actions pinned by SHA, `permissions: contents: read`.
- GM-1 … GM-9: all nine criteria of `SPEC-graph-model.md`.
- WL-1 … WL-8: all eight criteria of `SPEC-window-launcher.md`.
- EL-1 … EL-10: all ten criteria of `SPEC-event-log.md` (EL-8's 20 s figure is an initial target; record the measured number in the spec).

## Design
Layout per `CAPABILITY-MAP.md` "Package layout": `packages/graph` (`@loopwork/graph`), `packages/windows`
(`@loopwork/windows`), `packages/eventlog` (`@loopwork/eventlog`), scripts in `scripts/`, tests beside each package.
ESM, TS strict, project references, named exports only, `.js` import suffixes. Boundaries are in `CONSTRAINTS.md`:
`graph` imports nothing and no `node:*`; `windows` imports no `@loopwork/*`; `eventlog` only `import type` from `graph`.
`eventlog`'s `migrate(pool, { dirs })` must accept extra directories (used later by `@loopwork/runtime`).

## Implementation plan
- Step 1 (scaffold, SC-1…SC-7): workspace, tsconfig base, eslint (`no-explicit-any`, `no-console` in `packages/*`), vitest config, scripts, depcruise config, compose file, CI workflow, `.gitignore` additions.
- Step 2 (`graph-model`): types, schema subset + `inferSchema`/`isAssignable`/`conformsTo`, `parseFlow`, `validateFlow`, builder, fixtures (`simple-pipeline`, `foreach-100k`, `while-counter`, `retry-flaky`, `nested-frames`).
- Step 3 (`window-launcher`): pure planners and `quote.ts` first, then `execute.ts` with injected spawn.
- Step 4 (`event-log`): events and `EventStore`, `MemoryStore`, shared contract suite, `foldRun`/`applyEvent`, then `PgStore` + migrations + `migrate`.
Steps 2 and 3 are independent; step 4 depends on step 2 (types) and step 1.

## Files changed
Planned: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`,
`.dependency-cruiser.cjs`, `docker-compose.test.yml`, `.github/workflows/ci.yml`, `scripts/{floor-guard.sh,changed-line-coverage.mjs}`,
`packages/{graph,windows,eventlog}/**`.

## Interfaces
Public APIs exactly as in the three specs (`parseFlow`, `validateFlow`, `inferSchema`, `isAssignable`, `conformsTo`, `flow()`, `edgeId`, `scopedId`; `planTerminal`, `planAppWindow`, `openTerminal`, `openAppWindow`; `EventStore`, `MemoryStore`, `PgStore`, `migrate`, `foldRun`, `applyEvent`, event types). Error and event-type names are stable; additions only.

## How to verify
- Tests to run: `pnpm check:task`; `docker compose -f docker-compose.test.yml up -d && LOOPWORK_TEST_DATABASE_URL=postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test pnpm test:pg`.
- Functional check: `loopwork`-independent. Validate every graph-model fixture (`validateFlow`), run `planTerminal`/`planAppWindow` on each platform fixture, and run the event-log contract suite against both stores.
- Mapping: a grep script (or test) lists every criterion ID above and fails if one has no test named with it.

## Do not change
`CONSTRAINTS.md` (any threshold, rule or exception), `SPEC-*.md` and `CAPABILITY-MAP.md` (design questions go to `.develop/inbox/questions/`), `docs/adr/*`, `docs/PLAN.md`. Do not create packages for other modules.

## Open questions
- `base` is the HEAD of `docs/initial-plan` (it carries the specs), not the merge-base with `main` (which has none of them). Cut the working branch from `base`.
- The repo has no git remote, so PR creation will fail until one is added: commit and stop at the PR step, and raise it as a human interrupt rather than inventing a remote.
- New dev dependencies allowed (installed because the constraints need them): `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript-eslint`, `dependency-cruiser`, `pg`, `@types/pg`. Anything else: ask first via `.develop/inbox/questions/`. gitleaks, semgrep and osv-scanner are external binaries, not npm dependencies.
