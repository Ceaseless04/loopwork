# Plan: phase1-foundation

Spec (verbatim brief): `docs/develop/specs/phase1-foundation.md`
Source of truth for criteria: `CONSTRAINTS.md`, `SPEC-graph-model.md`, `SPEC-window-launcher.md`, `SPEC-event-log.md`
(a spec wins over the brief). Branch `feat/phase1-foundation`, cut from `0d6c7bf` (not `main`).

Read-only for every task: `CONSTRAINTS.md`, `SPEC-*.md`, `CAPABILITY-MAP.md`, `docs/adr/*`, `docs/PLAN.md`.
Design questions go to `/mnt/c/Users/krist/Downloads/side_project/loopwork/.develop/inbox/questions/` (main repo; `.develop/` is gitignored in the worktree). No git remote exists: commit on the branch, never push.

## Conventions for every task

- TDD: write the named tests first (`it('GM-3: <what it proves>', ...)`; the ID prefix is mandatory, T32 greps for it), watch them fail, then implement.
- Code style per `CAPABILITY-MAP.md`: ESM, strict TS, kebab-case files, named exports only, `.js` suffix on relative imports, no `any`, no suppression comments, no `console.*` or `process.stdout.write` in `packages/*`, expected failures as discriminated unions, thrown errors carry a stable `code`.
- Tests import from the module's own `src/<file>.js`, not from the package `index.ts`. `index.ts` is written exactly once per package, by that package's last task, so parallel tasks never collide on it.
- Task end: run whatever checks exist at that point (`pnpm typecheck`, `pnpm lint`, `pnpm test`, plus `scripts/floor-guard.sh` once T04 landed), then commit with a message that names the task id. Never weaken a threshold, skip a test, or edit `CONSTRAINTS.md`.
- Footprint = exact files a task may create or modify. Two tasks with no dependency path between them run in parallel only because their footprints are disjoint; do not touch files outside your footprint (ask instead).
- Test files that use `node:*` (fs, child_process) live outside `packages/graph` (depcruise rule 1 forbids `node:*` anywhere under it, tests included).
- Environment facts found while planning (verify at T01): local Node is v20.20.2 (spec says Node 22 LTS), `pnpm` is not installed (use `corepack enable`; pin `packageManager` in root `package.json`), `gitleaks`/`semgrep`/`osv-scanner` are not installed (external binaries, not npm deps; see T08 and T09), `docker` daemon works, `actionlint` is installed, network works.

## Acceptance-criteria coverage matrix

Every ID appears under exactly the tasks that satisfy it. "(part)" = one of several tasks sharing the criterion.

| ID | Tasks |
|---|---|
| SC-1 | T01, T02, T03 (named test), T32 (full run) |
| SC-2 | T04 |
| SC-3 | T06 |
| SC-4 | T08 (scripts equal CONSTRAINTS.md), T32 (90 s timing) |
| SC-5 | T05 |
| SC-6 | T07 |
| SC-7 | T09 |
| GM-1 | T18 |
| GM-2 | T10 (code table sync), T12 (part: E_SHAPE), T13 (part: E_DUPLICATE_ID, E_UNKNOWN_NODE, E_UNKNOWN_PORT, E_NESTING_DEPTH), T14 (part: E_CYCLE), T15 (part: E_MISSING_BUDGET, E_MISSING_EXIT, E_BAD_LIMIT), T16 (part: E_TYPE_MISMATCH, E_UNCONNECTED_PORT) |
| GM-3 | T15 |
| GM-4 | T14 |
| GM-5 | T16 |
| GM-6 | T11 |
| GM-7 | T11 (inline schema corpus), T18 (schemas extracted from the five fixtures) |
| GM-8 | T18 |
| GM-9 | T02 (lint rule), T18 (named test) |
| WL-1 | T21 (terminal), T22 (app window) |
| WL-2 | T23 |
| WL-3 | T20 |
| WL-4 | T22 (planner), T23 (openAppWindow result) |
| WL-5 | T22 |
| WL-6 | T21 |
| WL-7 | T21 |
| WL-8 | T23 |
| EL-1 | T26 (memory), T30 (pg) |
| EL-2 | T26, T30 |
| EL-3 | T31 |
| EL-4 | T25 (pure rule), T26, T30 |
| EL-5 | T26, T30 |
| EL-6 | T28 (memory), T30 (pg) |
| EL-7 | T27 |
| EL-8 | T31 |
| EL-9 | T29 |
| EL-10 | T31 |

## Dependency DAG

```
T01 -> T02 -> T03 -> { T04, T05, T06, T07 }          (T04..T07 parallel, disjoint footprints except T05 edits root package.json; no other of them does)
T04,T05,T06 -> T08 -> T09 (T09 also needs T07)
graph:    T03 -> T10 -> { T11, T13, T17 };  T11 -> T12;  T13 -> T14 -> T15 -> T16 (T16 also needs T11);  { T12, T16, T17 } -> T18
windows:  T03 -> { T19, T20 };  { T19, T20 } -> T21;  T19 -> T22;  { T20, T21, T22 } -> T23
eventlog: { T03, T18 } -> T24 -> T25 -> { T26, T27 };  { T26, T27 } -> T28;  { T24, T07 } -> T29;  { T28, T29 } -> T30 -> T31
final:    everything -> T32
```
Graph, windows and (after T18) eventlog chains are package-disjoint and may interleave freely once T03 is done. T24 waits for T18 (whole graph package built) so that a concurrent graph edit cannot race `tsc -b` of `graph/dist`.

---

# Part A: Scaffold (SC-1 .. SC-7)

## T01: Workspace, TypeScript base, three package skeletons, install

**Criteria:** SC-1 (part: install, build, typecheck).
**Depends on:** none.

**Files**
- `package.json` (root: `private`, `type: module`, `packageManager`, `engines.node >=22`, devDependencies, scripts `build`, `typecheck`)
- `pnpm-workspace.yaml` (`packages/*`, `apps/*`, `integrations/*`, `tests/*`)
- `tsconfig.base.json`, `tsconfig.json` (root, non-composite, covers `scripts/**/*.ts`, `vitest.config.ts`)
- `.gitignore` (append `coverage/`, `*.tsbuildinfo`, `.env.*`, keep existing lines)
- `.npmrc` only if needed
- `pnpm-lock.yaml` (generated; **only this task ever changes it**)
- `packages/graph/{package.json,tsconfig.json,src/index.ts}`
- `packages/windows/{package.json,tsconfig.json,src/index.ts}`
- `packages/eventlog/{package.json,tsconfig.json,src/index.ts}`

**Interfaces:** none (`src/index.ts` is `export {};`, owned later by the package's last task).
- `@loopwork/graph`: no dependencies; tsconfig `types: []`, no DOM/Node libs (so a `node:*` import fails typecheck; supports GM-9).
- `@loopwork/windows`: no dependencies, `types: ["node"]`.
- `@loopwork/eventlog`: `dependencies: { pg }`, `devDependencies: { @types/pg, @loopwork/graph: workspace:* }`, tsconfig project reference to `../graph`, `types: ["node"]`, scripts `test:pg` added later by T03.
- Each package: `exports` -> `dist/index.js` + `dist/index.d.ts`, `scripts.build = "tsc -b"`, `scripts.typecheck`.

**Steps**
- [ ] Verify tooling: `corepack enable && corepack prepare pnpm@<current stable> --activate`; `node -v` (if < 22, try `nvm install 22`; if impossible keep `engines` at `>=22` and record the mismatch in the commit message, do not lower it).
- [ ] Create root `package.json` with ONLY these devDependencies (the allowed set): `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript-eslint`, `dependency-cruiser`, `pg`, `@types/pg`. `pg` / `@types/pg` may live in `packages/eventlog` instead of root. No other dependency: if `@types/node` does not resolve (pnpm's default `public-hoist-pattern` hoists `@types/*` transitively via `@types/pg`), write a question to the inbox instead of adding it.
- [ ] Write `tsconfig.base.json`: `strict`, `module/moduleResolution NodeNext`, `target ES2022`, `composite`, `declaration`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck: false`.
- [ ] Create the three package skeletons as listed. Scripts: `build` = `tsc -b`; `typecheck` = `tsc -b` (or `tsc --noEmit -p .` if composite allows it; pick whichever is quickest and correct).
- [ ] Root scripts: `build` = `pnpm -r build`; `typecheck` = `pnpm -r typecheck && tsc -p tsconfig.json --noEmit`. Confirm `pnpm -r` excludes the workspace root (no recursion); if it does not, filter with `--filter './packages/*'`.
- [ ] `pnpm install` (generates `pnpm-lock.yaml`), `pnpm -r build`, `pnpm typecheck` pass on the empty skeletons.
- [ ] Commit (`T01: workspace scaffold`).

## T02: ESLint (flat config) with the constraint rules

**Criteria:** SC-1 (part: lint), GM-9 (part: lint rule).
**Depends on:** T01.

**Files:** `eslint.config.js`, root `package.json` (add `lint` script only).

**Interfaces:** `pnpm lint` = `eslint .` (zero errors required).

**Steps**
- [ ] Flat config with `typescript-eslint` recommended; global ignores: `**/dist/**`, `**/coverage/**`, `**/node_modules/**`, `**/*.diff`, `.develop/**`.
- [ ] Rules: `@typescript-eslint/no-explicit-any: error`; `no-console: error` for `packages/**`; `@typescript-eslint/ban-ts-comment` strict (no `@ts-ignore`, `@ts-expect-error` needs description); `no-restricted-imports` with pattern `node:*` and bare Node builtins for `packages/graph/**` (GM-9; message "graph is browser-loadable"); no `eslint-disable` allowed (`linterOptions.noInlineConfig: true`).
- [ ] Lint also covers `scripts/**/*.mjs` and `scripts/**/*.ts` and `vitest.config.ts` (Node globals only there).
- [ ] Add root script `lint`. Smoke-prove the rules by temporarily linting a scratch string via the ESLint API (do not commit it; the committed proof is T18's GM-9 test).
- [ ] `pnpm lint` passes; commit.

## T03: Vitest projects, test scripts, coverage config

**Criteria:** SC-1 (part: test, suffix split; the named test lives here).
**Depends on:** T02.

**Files**
- `vitest.config.ts`
- root `package.json` (add `test`, `test:pg`, `test:e2e`)
- `packages/{graph,windows,eventlog}/package.json` (add `test`; eventlog also `test:pg`)
- `scripts/test/sc-1-workspace.test.ts`

**Interfaces**
- Vitest `projects`: `unit` (`**/*.test.ts` minus `**/*.pg.test.ts` and `**/*.e2e.test.ts`, minus `node_modules`/`dist`), `pg` (`**/*.pg.test.ts`), `e2e` (`**/*.e2e.test.ts`).
- `test` = `vitest run --project unit` (must accept an appended `--coverage`); `test:pg` = `vitest run --project pg --passWithNoTests`; `test:e2e` = `vitest run --project e2e --passWithNoTests`.
- Coverage: provider `v8`, reporters `lcov` + `text-summary`, `include` `packages/*/src/**` and `scripts/*.mjs` (so unloaded changed files still show as uncovered), `exclude` config files by path (no ignore comments).
- Per-package `pnpm --filter @loopwork/<pkg> test` runs only that package's unit tests; `pnpm --filter @loopwork/eventlog test:pg` runs only its pg tests.

**Steps**
- [ ] Write `scripts/test/sc-1-workspace.test.ts` with `it('SC-1: vitest projects separate *.test.ts, *.pg.test.ts and *.e2e.test.ts', ...)`: import the config, assert the three projects and that a representative file name is matched by exactly one project; plus `it('SC-1: root and every package expose build/typecheck/lint/test scripts', ...)` reading the `package.json` files.
- [ ] Verify vitest's current `projects` config API (the installed major may differ from older docs); implement `vitest.config.ts`.
- [ ] Add scripts; confirm `pnpm test`, `pnpm test --coverage` (writes `coverage/lcov.info`), `pnpm test:pg` and `pnpm test:e2e` all exit 0 on the current tree, and the per-package filters work.
- [ ] Commit.

## T04: `scripts/floor-guard.sh` and its fixture-diff tests

**Criteria:** SC-2.
**Depends on:** T03.

**Files**
- `scripts/floor-guard.sh` (executable)
- `scripts/test/floor-guard.test.ts`
- `scripts/test/fixtures/floor-guard/*.diff` (one failing diff per rule + `clean.diff` + a few "must pass" diffs)

**Interfaces** (shell CLI)
`floor-guard.sh [--diff-file <path>|-] [--commit-msg-file <path>]`; default diff = tracked changes vs base plus untracked files rendered via `git diff --no-index /dev/null <file>`; base = `$LOOPWORK_BASE_REF`, else `git merge-base HEAD main`. Exit 0 = clean; non-zero prints `floor-guard: <rule-id> <file>:<line>` per violation to stderr (stdout stays quiet). Rule ids: `suppression`, `stub`, `skipped-test`, `secret`, `stdout`, `bind`, `constraints-weakened`.

**Steps**
- [ ] Write the tests first. Fixtures are `.diff` files only: never embed the forbidden strings in a `.ts` file (the guard and lint would flag the test itself). Cases: each of the seven rules fails (`suppression`: `@ts-ignore`, `@ts-expect-error` without a reason, `eslint-disable`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`, `/* v8 ignore */`; `stub`: `throw new Error('Not implemented')`, empty `catch {}`, `TODO` where an implementation should be; `skipped-test`: `.skip`, `.todo`, `xit`, `xdescribe`, a deleted `*.test.ts`, net-removed `expect(` lines; `secret`; `stdout`: `console.log` or `process.stdout.write` under `packages/*/src`; `bind`: `0.0.0.0`, `'::'`, `host:` other than loopback; `constraints-weakened`: any removed or changed line in `CONSTRAINTS.md`, or any added row under "Exceptions"). Each `it` is named `SC-2: <rule> ...`.
- [ ] Must-pass cases: `@ts-expect-error: <reason>`, a diff touching only `.md` files that mention the words, pure additions to `CONSTRAINTS.md` outside Exceptions, `host: '127.0.0.1'`, the documented test database URL `postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test` (explicit allowlist, with a comment saying why), and a skip/removed-test diff accompanied by a commit-message file containing a non-empty `Test-Change-Reason:` line.
- [ ] Also: `it('SC-2: exits 0 on a clean tree')` creating a temp git repo (`git init` in `os.tmpdir()`) with no changes, running the script, expecting 0.
- [ ] Implement the script: pure bash/grep/awk over the unified diff, added lines only (`+` lines, excluding `+++`); suppression/stub/stdout/bind rules apply to code files only (`*.ts,*.tsx,*.js,*.mjs,*.cjs`) so spec and docs text that merely mention the words never trip it; secret rule applies to all files. Edit-loop budget: under 5 s.
- [ ] Real-world false-positive check: run the guard with `LOOPWORK_BASE_REF=0d6c7bf` on the current branch; it must exit 0. Record in the commit message that this was done.
- [ ] Note on the `spawnSync` use inside a `*.test.ts`: this is a tool test of a shell script, it runs in the `unit` project on purpose (SC-2 must be proven by `pnpm test`). Say so in a comment at the top of the test file.
- [ ] Commit.

## T05: `scripts/changed-line-coverage.mjs` and the `pnpm test --coverage` hook

**Criteria:** SC-5.
**Depends on:** T03.

**Files**
- `scripts/changed-line-coverage.mjs`
- `scripts/test.mjs` (thin wrapper used by the root `test` script)
- `scripts/test/changed-line-coverage.test.ts`
- root `package.json` (change `test` to `node scripts/test.mjs --project unit`)

**Interfaces** (named exports, so they are unit-testable)
```
parseLcov(text: string): Map<string, Map<number, number>>        // file -> line -> hits (DA records)
parseAddedLines(diff: string): Map<string, Set<number>>          // file -> added line numbers, from `git diff -U0`
changedLineCoverage(lcov, added): { covered: number; total: number; pct: number; uncovered: Map<string, number[]> }
main(argv, deps?): Promise<number>                                // exit code; deps inject git + fs
```
CLI: `node scripts/changed-line-coverage.mjs [--lcov coverage/lcov.info] [--base <ref>] [--threshold 80]`. Base = `--base`, else `$LOOPWORK_BASE_REF`, else `git merge-base HEAD main`. Untracked files count as fully added. Only executable lines (present as `DA` in lcov) are counted; files absent from lcov are ignored; empty set = pass. Exit non-zero and list uncovered `file:line` when `pct < threshold`.

**Steps**
- [ ] Tests first (`it('SC-5: ...')`): lcov parsing, diff parsing (renames, deletions, multiple hunks, `-U0` headers), the intersection (e.g. 3 of 4 changed executable lines covered = 75% fails at 80, 4 of 5 passes), non-executable and unmeasured files ignored, empty diff passes, `--threshold` override, untracked file handling via injected deps, and exit codes from `main`.
- [ ] Implement. This blocks immediately (CONSTRAINTS.md says "starts blocking 2026-10-26"; blocking earlier is a tightening and is allowed). No date logic.
- [ ] `scripts/test.mjs`: spawns `vitest run <forwarded args>`; if the forwarded args include `--coverage` and vitest exited 0, runs `main()` from the module above and exits with its code; otherwise exits with vitest's code. `pnpm test` and `pnpm test --coverage` both work; `pnpm --filter <pkg> test` is unaffected.
- [ ] Prove end to end on the current tree: `pnpm test --coverage` exits 0 and prints the changed-line percentage.
- [ ] Commit.

## T06: `.dependency-cruiser.cjs` (architecture rules 1..10) and fixture proof

**Criteria:** SC-3.
**Depends on:** T03.

**Files**
- `.dependency-cruiser.cjs`
- `scripts/test/depcruise-rules.test.ts`
- `scripts/test/fixtures/depcruise/<rule-id>/**` (one miniature repo per rule, each laid out as `packages/<pkg>/src/*.ts` etc. with a fixture-local `tsconfig.json` whose `paths` map `@loopwork/<pkg>` to the fixture's `packages/<pkg>/src/index.ts`) plus a `allowed/` fixture exercising every permitted import

**Interfaces:** forbidden rules named `rule-01-graph-isolated` .. `rule-10-no-circular`, all `severity: 'error'` (SC-3 requires `depcruise --validate` to fail; blocking now is a tightening and is allowed).

**Steps**
- [ ] Write the fixture repos first. Each must violate exactly its rule: (1) graph value-or-type import of another `@loopwork/*` and a `node:*` import; (2) eventlog value import of graph, and eventlog importing another package; (3) windows importing any `@loopwork/*`; (4) engine importing runtime/service/ui-server/mcp/apps; (5) runtime importing service or a front door; (6) service importing ui-server/mcp/apps/integrations; (7) a front door value-importing `pg`, engine, runtime or eventlog; (8) ui-viewer importing a non-graph value, a `node:*`, or a non-type `service` import (the "fetch only to same-origin /api" clause is not expressible in dependency-cruiser: document that in a comment in the config and in the commit message, do not fake it); (9) cli with a static import of `@loopwork/claude-integration`, and claude integration importing cli values; (10) a two-file cycle.
- [ ] The `allowed/` fixture proves the `import type` allowances (eventlog -> graph type, front door -> graph/eventlog/service types) and `import()` dynamic import from cli to claude-integration pass.
- [ ] Test (`it('SC-3: rule N ...')`, one per rule, plus `it('SC-3: allowed imports pass')`): run depcruise against each fixture with the fixture as root and the real config, assert the violation names that rule. Prefer the `dependency-cruiser` JS API (`cruise`) over spawning the CLI to keep the unit run fast; add one real CLI invocation (`depcruise --validate`) on one failing fixture to prove the exit code. Spawning is acceptable here for the same reason as T04.
- [ ] Implement the config: set `options.tsPreCompilationDeps: true` (needed to see `import type`), `tsConfig`, `doNotFollow` for `node_modules`, `exclude` for `scripts/test/fixtures` when running on the real repo. Rule path patterns must match BOTH the workspace-symlink-resolved form and the `@loopwork/<pkg>` specifier, and use `dependencyTypes`/`dependencyTypesNot` (`type-only`, `core`, `dynamic`) as appropriate. Rule 1's `node:*` ban uses `dependencyTypes: ['core']`.
- [ ] Verify on the real repo that bare `depcruise --validate` (exactly the string in `CONSTRAINTS.md`) runs without a path argument and exits 0. If the installed dependency-cruiser requires path arguments, do NOT edit the script string: write a question to the inbox and stop this step.
- [ ] Commit.

## T07: `docker-compose.test.yml` and Postgres test wiring

**Criteria:** SC-6.
**Depends on:** T03.

**Files**
- `docker-compose.test.yml`
- `scripts/test/compose.test.ts`
- Usage notes live in comments inside the compose file; no extra doc file.

**Interfaces:** service `postgres` (image `postgres:16`), published `127.0.0.1:55432:5432` (loopback only, floor rule), `POSTGRES_DB=loopwork_test`, `POSTGRES_USER=loopwork`, `POSTGRES_PASSWORD=loopwork`, a healthcheck (`pg_isready`), tmpfs data dir for speed. `pnpm test:pg` (from T03) reads `LOOPWORK_TEST_DATABASE_URL`; pg test helpers (T29) fail loudly with a clear message when it is unset (never silently skip).

**Steps**
- [ ] Test first: `it('SC-6: compose file pins Postgres 16 on 127.0.0.1:55432 with db/user/password loopwork_test/loopwork/loopwork')` parsing the YAML as text (no YAML dependency; regex/line assertions) and `it('SC-6: test:pg script runs the pg project')` reading root `package.json`.
- [ ] Write the compose file. Manually verify: `docker compose -f docker-compose.test.yml up -d --wait`, then `pg_isready`/`psql` (via `docker compose exec`) against `postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test`, then `LOOPWORK_TEST_DATABASE_URL=... pnpm test:pg` exits 0 (no pg tests exist yet, so `--passWithNoTests`), then `docker compose ... down -v`.
- [ ] Commit.

## T08: `check:fast`, `check:task`, `check:full` and the external binaries

**Criteria:** SC-4 (part: scripts exactly as in CONSTRAINTS.md).
**Depends on:** T04, T05, T06.

**Files:** root `package.json` (add the three scripts), `scripts/test/check-scripts.test.ts`.

**Steps**
- [ ] Test first: `it('SC-4: check:fast, check:task and check:full equal the JSON block in CONSTRAINTS.md')` — extract the fenced ```json block from `CONSTRAINTS.md`, parse, compare each script string for equality with root `package.json`. (Reads files via `node:fs`; lives under `scripts/test`.)
- [ ] Add the three scripts verbatim from `CONSTRAINTS.md`. Do not reword them.
- [ ] Install the external binaries that `check:fast`/`check:task` call, OUTSIDE the repo and without adding npm dependencies: `gitleaks` (pinned release binary into `~/.local/bin`, verify checksum). `semgrep` and `osv-scanner` are only needed by `check:full` (CI, T09); install locally only if cheap (`pipx install semgrep`, release binary for osv-scanner), otherwise leave to CI and say so in the commit message.
- [ ] Confirm `pnpm check:fast` and `pnpm check:task` exit 0 now. If a binary cannot be installed in this environment, stop and raise a human interrupt through the inbox; do not edit the scripts to drop it.
- [ ] Commit.

## T09: `.github/workflows/ci.yml`

**Criteria:** SC-7.
**Depends on:** T04, T05, T06, T07, T08.

**Files:** `.github/workflows/ci.yml`, `scripts/test/ci-workflow.test.ts`.

**Interfaces:** top-level `permissions: contents: read`; jobs: `fast` (install, typecheck, lint, gitleaks, floor-guard), `task` (unit + coverage via `pnpm test --coverage`, depcruise), `pg` (Postgres 16 service container on `127.0.0.1:55432:5432`, `LOOPWORK_TEST_DATABASE_URL`, `pnpm test:pg`), `e2e` (`pnpm test:e2e`), `semgrep` (`--config p/default --config p/typescript --error`), `osv-scanner` (`scan source -r .`). Checkout uses `fetch-depth: 0`; `LOOPWORK_BASE_REF` set to the PR base (or the default branch) for floor-guard and changed-line coverage.

**Steps**
- [ ] Test first: `it('SC-7: every uses: is pinned to a 40-hex SHA')`, `it('SC-7: permissions is contents: read at top level and no job widens it')`, `it('SC-7: workflow runs gitleaks, semgrep, osv-scanner, depcruise and pg tests')` (assert the command strings from `check:full`).
- [ ] Resolve real commit SHAs for each action with `git ls-remote` / `gh api` (network is available) and write `uses: owner/repo@<sha> # vX.Y.Z`. Never invent a SHA; if one cannot be resolved, ask via the inbox. Binary tools (gitleaks, semgrep, osv-scanner) are installed by pinned action or pinned-version download with checksum.
- [ ] `actionlint .github/workflows/ci.yml` passes (it is installed locally).
- [ ] CI config is "ask first" in `CAPABILITY-MAP.md`; this brief explicitly authorizes it (SC-7), so no question is needed, but note in the commit message that the brief is the authorization.
- [ ] Commit.

---

# Part B: `@loopwork/graph` (GM-1 .. GM-9)

Test files live in `packages/graph/test/` and only import from `../src/<file>.js`. Fixture JSON is loaded with JSON module imports (no `node:fs`) so the package stays browser-loadable. JSON-pointer path convention (fixed in T13, documented at the top of `src/walk.ts`, asserted by every per-code test): outer scope pointer is `''`, a body scope is `/nodes/<frameId>/body` (nested: `/nodes/a/body/nodes/b/body`); node problems `<scope>/nodes/<id>`; edge problems `<scope>/edges/<i>`; edge endpoint problems `<scope>/edges/<i>/from/node` (or `.../to/port` etc.); budget problems `/nodes/<frame>/budgets/<field>`; cycle problems at the scope pointer.

## T10: Types, ids, error-code table sync

**Criteria:** GM-2 (part: table/union sync).
**Depends on:** T03.

**Files**
- `packages/graph/src/types.ts`, `packages/graph/src/ids.ts`, `packages/graph/src/index.ts` (type-only exports now; T18 completes it)
- `packages/graph/test/ids.test.ts`
- `scripts/test/spec-sync-graph-codes.test.ts` (outside the graph package because it reads the spec with `node:fs`)

**Interfaces**
```ts
// types.ts: exactly the IR in SPEC-graph-model.md
export type JsonValue; Schema; PortSpec; Flow; FlowNode; Frame; Body; Budgets; Edge; PortRef;
export const ERROR_CODES = ['E_SHAPE','E_DUPLICATE_ID','E_UNKNOWN_NODE','E_UNKNOWN_PORT','E_CYCLE','E_MISSING_BUDGET','E_MISSING_EXIT','E_TYPE_MISMATCH','E_UNCONNECTED_PORT','E_BAD_LIMIT','E_NESTING_DEPTH'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ValidationError = { code: ErrorCode; message: string; node?: string; edge?: string; path: string };
export type ParseResult = { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] };
export type ValidationResult = { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] };
// ids.ts
export function edgeId(e: Edge): string;            // `${from.node}.${from.port}->${to.node}.${to.port}`
export function scopedId(...parts: string[]): string; // parts joined with '.'
```
`index.ts` now has `export type { ... } from './types.js'` and `export { ERROR_CODES }` so eventlog can type-import `Flow` and `JsonValue`; T18 adds the rest.

**Steps**
- [ ] Tests first: `edgeId`/`scopedId` examples including nested scopes; `it('GM-2: ErrorCode union and the SPEC-graph-model.md error table list the same codes')` which parses the table in `SPEC-graph-model.md` (rows split on ` / ` for the two-code row) and compares to `ERROR_CODES` both ways.
- [ ] Implement types (verbatim shapes from the spec; `Schema` includes the `{}` any-schema), ids, and `index.ts` type exports.
- [ ] `pnpm --filter @loopwork/graph build` emits `dist/index.d.ts` exporting `Flow` and `JsonValue`; commit.

## T11: Schema inference, assignability, conformance

**Criteria:** GM-6, GM-7.
**Depends on:** T10.

**Files:** `packages/graph/src/schema.ts`, `packages/graph/test/schema.test.ts`.

**Interfaces**
```ts
export function inferSchema(samples: JsonValue[]): Schema;        // [] -> {}
export function isAssignable(from: Schema, to: Schema): boolean;
export function conformsTo(value: JsonValue, schema: Schema): boolean;
```

**Steps**
- [ ] Tests first: `GM-6: inferSchema merges 1 and 2.5 into number` (all-integers -> `integer`), objects with differing keys give optional properties (only keys present in every sample are `required`), mixed kinds give `anyOf`, arrays merge item schemas, empty samples give `{}`; property-style: over a seeded pseudo-random corpus of JSON values (own tiny PRNG, no new dependency) `conformsTo(sample, inferSchema(samples))` holds for every sample.
- [ ] `GM-7: isAssignable is reflexive and transitive` over a corpus of schemas (every kind, nested), `integer` assignable to `number` and not the reverse, `{}` accepts everything, `anyOf` is assignable only if every member is (conservative; document false negatives in a code comment on the function), `enum` subset rules, object width rules (extra properties allowed unless `additionalProperties: false`), required-ness.
- [ ] Implement iteratively where recursion depth could blow up on large inputs; no `node:*`.
- [ ] Commit.

## T12: `parseFlow` (shape, `inferFrom`)

**Criteria:** GM-2 (part: E_SHAPE).
**Depends on:** T10, T11.

**Files:** `packages/graph/src/parse.ts`, `packages/graph/test/parse.test.ts`, `packages/graph/test/codes/e-shape.test.ts`.

**Interfaces:** `export function parseFlow(input: unknown): ParseResult` — structural check only; resolves every `PortSpec` `{ inferFrom }` to a `Schema` via `inferSchema`; collects all errors, sorted by `path`.

**Steps**
- [ ] Tests first (table-driven, expected `code` + `path` each): non-object input, `version !== 1`, missing/ill-typed `id`/`name`/`nodes`/`edges`, unknown `kind`, unknown `frame`, a schema keyword outside the subset (e.g. `pattern`, `$ref`), ill-typed `Budgets`/`Body`/`PortRef` fields, plus `inferFrom` resolution (result schema equals `inferSchema(samples)`; the returned `Flow` contains no `inferFrom`). Name them `GM-2: E_SHAPE ...`. A valid object returns `ok: true` and does not mutate the input.
- [ ] Implement with hand-written checks (no schema library), iterative where input depth is unbounded.
- [ ] Commit.

## T13: Validator core: scope walker, ids, endpoints, nesting depth

**Criteria:** GM-2 (part: E_DUPLICATE_ID, E_UNKNOWN_NODE, E_UNKNOWN_PORT, E_NESTING_DEPTH).
**Depends on:** T10.

**Files**
- `packages/graph/src/walk.ts` (scope iterator over outer graph + every body, yielding `{ scopePath, scopeId, nodes, edges, depth }`; pointer convention documented at top)
- `packages/graph/src/validate-structure.ts`
- `packages/graph/src/validate.ts` (orchestrator: `validateFlow` runs an ordered list of checkers, concatenates errors, sorts by `path`; T14..T16 each append one checker)
- `packages/graph/test/codes/e-duplicate-id.test.ts`, `e-unknown-node.test.ts`, `e-unknown-port.test.ts`, `e-nesting-depth.test.ts`

**Interfaces**
```ts
export function validateFlow(flow: Flow): ValidationResult;
export function* walkScopes(flow: Flow): Iterable<Scope>;          // iterative, no recursion
export function portsOf(node: FlowNode): { in: boolean; out: boolean; error: boolean };  // per-kind port rules
```
Port rules: `source` has `out`; `map` has `in`,`out`; `sink` has `in`; frames have `in`,`out`, plus `error` only for `retry` with `onExhausted: 'emit-error'`. Body edges address body nodes by id within the body, and the frame's own boundary via `entry`/`exit` refs.

**Steps**
- [ ] Tests first, one minimal failing flow per code with the exact expected `code` and `path` (names `GM-2: E_DUPLICATE_ID ...` etc.): duplicate id within one scope and an id containing `.`; an edge to a missing node (`from` and `to` variants); an edge to a port the kind lacks (e.g. `sink.out`, `retry.error` without `emit-error`); nesting of 9 frames fails, 8 passes. Also assert a flow with several problems reports them all, sorted by `path`.
- [ ] Implement `walkScopes`, `portsOf`, the structure checker and the orchestrator.
- [ ] Commit.

## T14: Cycle detection

**Criteria:** GM-2 (part: E_CYCLE), GM-4.
**Depends on:** T13.

**Files:** `packages/graph/src/validate-cycles.ts`, `packages/graph/src/validate.ts` (register checker), `packages/graph/test/codes/e-cycle.test.ts`.

**Interfaces:** `export function findCycle(nodeIds: string[], edges: Edge[]): string[] | undefined` (iterative DFS or Kahn, returns the cycle's ids in order); checker `checkCycles(flow): ValidationError[]`; message `cycle: a -> b -> a`.

**Steps**
- [ ] Tests first: `GM-4: a cycle in the outer graph yields E_CYCLE`, `... in a body ...`, `... across a nested frame's body ...` (each with its scope `path`), `GM-4: the same topology expressed with a frame validates` (a back-edge loop rewritten as a `while`/`foreach` frame passes this checker). Also `GM-2: E_CYCLE ...` table entry, self-loop edge, and a 200k-node chain does not overflow the stack.
- [ ] Implement iteratively; register in `validate.ts`; commit.

## T15: Budgets, exits, limits

**Criteria:** GM-2 (part: E_MISSING_BUDGET, E_MISSING_EXIT, E_BAD_LIMIT), GM-3.
**Depends on:** T14.

**Files:** `packages/graph/src/validate-limits.ts`, `packages/graph/src/validate.ts` (register), `packages/graph/test/codes/e-missing-budget.test.ts`, `e-missing-exit.test.ts`, `e-bad-limit.test.ts`.

**Interfaces:** `checkLimits(flow): ValidationError[]`.
- `E_MISSING_BUDGET`: frame lacks `maxIterations` or `maxDurationMs`, or either is not a positive integer (`path` `/nodes/<frame>/budgets/<field>`).
- `E_MISSING_EXIT`: `while`/`until` without `condition`; `retry` with `maxAttempts < 1`; frame body has no path from `entry` to `exit`.
- `E_BAD_LIMIT`: `concurrency` or `maxAttempts` not a positive integer; `backoff.baseMs` negative (also for `map`/`sink` `concurrency`).

**Steps**
- [ ] Tests first: `GM-3: a frame missing maxIterations fails with E_MISSING_BUDGET`, same for `maxDurationMs`, same for `0`/`-1`/`1.5`/non-number, `GM-3: the same flow with budgets passes`; table entries for the other codes with exact paths; optional `maxCostUsd`/`maxTokens` are accepted and carried but not checked beyond type (unit test).
- [ ] Implement over `walkScopes`; the entry-to-exit reachability check is iterative.
- [ ] Register in `validate.ts`; commit.

## T16: Wiring and type checks

**Criteria:** GM-2 (part: E_TYPE_MISMATCH, E_UNCONNECTED_PORT), GM-5.
**Depends on:** T15, T11.

**Files:** `packages/graph/src/validate-types.ts`, `packages/graph/src/validate.ts` (register), `packages/graph/test/codes/e-type-mismatch.test.ts`, `e-unconnected-port.test.ts`.

**Interfaces:** `checkTypes(flow): ValidationError[]`.
- Every edge: schema of the `from` port must be `isAssignable` to the `to` port's schema (frame boundary ports use the frame's `in`/`out`; a body's `entry` receives the frame `in` schema, its `exit` produces the frame `out` schema).
- `while`/`until`: body output schema must be assignable to body input schema (state loop), else `E_TYPE_MISMATCH` at the frame's `/nodes/<frame>/body`.
- `E_UNCONNECTED_PORT`: a required input port (`map.in`, `sink.in`, frame `in`, body `entry`) with no incoming edge. An `out` with no outgoing edge is allowed (test asserts this does not error).

**Steps**
- [ ] Tests first: `GM-5: a while frame whose body output is not assignable to its input yields E_TYPE_MISMATCH` (plus the passing counterpart, plus `until`), edge mismatch (`string` into `number`, `number` into `integer`), `integer` into `number` passes, `{}` passes both ways, `GM-2: E_UNCONNECTED_PORT ...`, dropped output allowed.
- [ ] Implement; register; commit.

## T17: `flow()` builder

**Criteria:** none directly (supports GM-1 fixtures and the 5,000-node test).
**Depends on:** T10.

**Files:** `packages/graph/src/builder.ts`, `packages/graph/test/builder.test.ts`.

**Interfaces**
```ts
export function flow(id: string, name: string): FlowBuilder;
interface FlowBuilder {
  source(id: string, spec: { fn: string; params?: JsonValue; out: PortSpec | Schema }): FlowBuilder;
  map(id: string, spec: { fn: string; params?: JsonValue; in: ...; out: ...; concurrency?: number }): FlowBuilder;
  sink(id: string, spec: { fn: string; params?: JsonValue; in: ...; concurrency?: number }): FlowBuilder;
  frame(id: string, frame: Frame /* with body built via nested flow-like callback or a literal Body */): FlowBuilder;
  edge(from: `${string}.${string}`, to: `${string}.${string}`): FlowBuilder;   // "node.port" strings
  build(): Flow;                                                             // does not validate; returns a fresh object
}
```
(exact generics are the implementer's choice; the surface above is the contract: fluent, `build()` returns a plain `Flow`, never validates, never mutates after build.)

**Steps**
- [ ] Tests first: builder output deep-equals a hand-written literal for a source->map->sink flow and for a `foreach` frame with a body; `build()` twice returns independent objects; invalid input is not rejected (validation is `validateFlow`'s job).
- [ ] Implement; commit.

## T18: Fixtures, performance, no-Node guard, public API

**Criteria:** GM-1, GM-7 (part: fixture schemas), GM-8, GM-9 (named test).
**Depends on:** T12, T16, T17.

**Files**
- `packages/graph/test/fixtures/{simple-pipeline,foreach-100k,while-counter,retry-flaky,nested-frames}.flow.json`
- `packages/graph/test/fixtures.test.ts`, `packages/graph/test/perf.test.ts`
- `scripts/test/gm-9-no-node-imports.test.ts`
- `packages/graph/src/index.ts` (final public exports)

**Interfaces:** `index.ts` exports exactly: `parseFlow`, `validateFlow`, `inferSchema`, `isAssignable`, `conformsTo`, `flow`, `edgeId`, `scopedId`, `ERROR_CODES`, and the types listed in T10. Named exports only.

**Steps**
- [ ] Author the five fixtures per the spec's list (`foreach-100k`: a `foreach` frame over a generated source sized by `params`, with `concurrency` and budgets; `while-counter`: state-loop schema assignable body; `retry-flaky`: `retry` frame with backoff and `emit-error`; `nested-frames`: foreach containing while containing retry; `simple-pipeline`: source -> map -> sink). They are reused by other modules later, so keep them realistic and valid.
- [ ] Tests first: `GM-1: <fixture> validates ok` for each of the five (via `parseFlow` then `validateFlow`); fixtures also deep-equal their `flow()`-built counterparts for at least two of them; `GM-7: isAssignable is reflexive and transitive on schemas extracted from the fixtures`.
- [ ] `GM-8: validating a 5,000-node flow completes in under 1 s`: generate the flow in the test (chain of map nodes plus a few frames), time with `performance.now()`, and assert < 1000 ms.
- [ ] `GM-9: packages/graph has no node: imports`: use the ESLint API (`new ESLint({...}).lintText`) with a throwaway string under a `packages/graph/src/` file path to prove `no-restricted-imports` fires on `import 'node:fs'`, and lint the real `packages/graph/**` tree expecting zero errors. (The depcruise rule 1 from T06 is the second line of defense.)
- [ ] Write the final `index.ts`; `pnpm --filter @loopwork/graph build` still emits clean declarations; commit.

---

# Part C: `@loopwork/windows` (WL-1 .. WL-8)

Tests live in `packages/windows/test/`. Fixtures are `LaunchEnv` snapshots built by a helper (no real FS or PATH access in planner tests). No `@loopwork/*` imports.

## T19: Types, platform detection, env fixtures

**Criteria:** none directly (supports WL-1, WL-5).
**Depends on:** T03.

**Files:** `packages/windows/src/types.ts`, `packages/windows/src/platform.ts`, `packages/windows/test/fixtures/env.ts`, `packages/windows/test/platform.test.ts`.

**Interfaces**
```ts
export type Platform = 'wsl' | 'darwin' | 'linux' | 'win32';
export type LaunchEnv = { platform: Platform; env: Record<string, string | undefined>; exists(path: string): boolean; which(cmd: string): string | undefined };
export type TerminalRequest; LaunchPlan; LaunchResult;     // exactly as in the spec
export function detectPlatform(env: Record<string, string | undefined>, fs: { exists(p: string): boolean; readFile(p: string): string | undefined }, platform?: string): Platform;
export function makeEnv(opts: { platform: Platform; env?: Record<string,string>; tools?: string[]; files?: string[] }): LaunchEnv;   // test helper
```
`detectPlatform`: `win32` -> `win32`; `darwin` -> `darwin`; `linux` with `/proc/version` mentioning `microsoft`/`WSL` or `WSL_DISTRO_NAME` set -> `wsl`; other linux -> `linux`.

**Steps**
- [ ] Tests first: each detection branch; `makeEnv` fixtures for the eight named scenarios used later: `wsl` (with wt.exe), `wsl-no-wt`, `darwin`, `darwin-iterm`, `linux` (display), `linux-no-display`, `linux-custom-terminal` (`LOOPWORK_TERMINAL`), `win32`.
- [ ] Implement; commit.

## T20: `quote.ts`

**Criteria:** WL-3.
**Depends on:** T03.

**Files:** `packages/windows/src/quote.ts`, `packages/windows/test/quote.test.ts`.

**Interfaces**
```ts
export function quotePosix(arg: string): string;          // single-quote style, safe inside sh -c
export function joinPosix(argv: string[]): string;
export function quoteCmd(arg: string): string;            // cmd.exe quoting incl. % and ^ and "
export function joinCmd(argv: string[]): string;
```

**Steps**
- [ ] Tests first: `WL-3: quotePosix round-trips hostile strings through real sh` — corpus: single and double quotes, spaces, `$VAR`, `$(cmd)`, backticks, `;`, `&`, `|`, `%`, `\`, newlines, leading `-`, empty string, unicode; run `sh -c 'printf %s "$1"' _ <quoted-via-the-wrapping-command>` with `spawnSync` and assert the output equals the input byte for byte (the test file may use `node:child_process`; this follows the spec text, so it runs in the `unit` project). `WL-3: quoteCmd matches the expectation table` — a literal table of input -> expected string covering the same corpus.
- [ ] Implement; document each escaping decision in a one-line comment; commit.

## T21: `planTerminal`

**Criteria:** WL-1 (terminal), WL-6, WL-7.
**Depends on:** T19, T20.

**Files:** `packages/windows/src/plan-terminal.ts`, `packages/windows/test/plan-terminal.test.ts`.

**Interfaces:** `export function planTerminal(req: TerminalRequest, env: LaunchEnv): LaunchPlan | undefined` — pure, implements the Terminal column of the strategy table in order (steps array lists every fallback so `execute` tries them in order; `which`/`exists` decide which steps are included). Returns `undefined` when no terminal strategy is available (e.g. Linux without `DISPLAY`/`WAYLAND_DISPLAY`).

**Steps**
- [ ] Tests first: `WL-1: <fixture> first step is the documented first choice` for all fixtures (wsl: `wt.exe -w new --title T wsl.exe --cd <cwd> -- <argv...>`; darwin: `osascript` (iTerm when `TERM_PROGRAM=iTerm.app`); linux: `x-terminal-emulator -e`; win32: `wt.exe`), and `WL-1: removing that tool from which yields the next choice` walking the whole chain for each platform (wsl -> `cmd.exe /c start wsl.exe`; linux -> gnome-terminal, kitty, konsole, xterm). `WL-6: keepOpen true (default) wraps the command` with the exact `sh -c '<cmd>; printf "\n[loopwork exited — press Enter to close]"; read _'` shape (and `cmd /k` on Windows targets), `WL-6: keepOpen false does not wrap`. `WL-7: LOOPWORK_TERMINAL overrides discovery and is split on whitespace into argv` (assert no shell step is introduced, and that it wins over every platform's table).
- [ ] Argv is passed as an array wherever no shell is needed; quoting via T20 only for `sh -c` / `cmd.exe /c` payloads; never string-concatenate user input into a command line.
- [ ] Implement; commit.

## T22: `planAppWindow`

**Criteria:** WL-1 (app window), WL-4 (planner), WL-5.
**Depends on:** T19.

**Files:** `packages/windows/src/plan-app-window.ts`, `packages/windows/test/plan-app-window.test.ts`.

**Interfaces:** `export function planAppWindow(url: string, env: LaunchEnv): LaunchPlan | undefined`; `export const LOCAL_URL: RegExp` = `^https?://(127\.0\.0\.1|localhost)(:\d+)?(/[A-Za-z0-9._~:/?=#&%-]*)?$` (exactly as in the spec). Returns `undefined` for any URL not matching.

**Steps**
- [ ] Tests first: `WL-1: <fixture> first step is the documented first choice` for the App window column (wsl: Chrome/Edge `--app=<url>`; darwin: `open -na "Google Chrome" --args --app=<url>`; linux: `google-chrome`/`chromium`/`microsoft-edge`; win32), and the next-choice walk per platform when the tool is removed (darwin Edge then `open <url>`; linux `xdg-open <url>`; wsl `wslview`, then `cmd.exe /c start "" <url>`). `WL-4: planAppWindow rejects non-local URLs, URLs with spaces, ", ;, |, backticks, and file:/javascript: schemes` (table of at least 12 inputs, each returns `undefined`; accepted: `http://127.0.0.1:5173/`, `https://localhost/a?b=c#d`). `WL-5: wsl finds Chrome/Edge under both Program Files and Program Files (x86)`; with neither, the plan is `wslview`, then `cmd.exe /c start "" <url>`.
- [ ] Implement; commit.

## T23: `execute.ts` and the public API

**Criteria:** WL-2, WL-4 (result), WL-8.
**Depends on:** T20, T21, T22.

**Files:** `packages/windows/src/plan.ts` (barrel re-exporting both planners), `packages/windows/src/execute.ts`, `packages/windows/src/index.ts` (final), `packages/windows/test/execute.test.ts`.

**Interfaces**
```ts
export function openTerminal(req: TerminalRequest, env?: LaunchEnv, deps?: { spawn?: SpawnFn }): Promise<LaunchResult>;
export function openAppWindow(url: string, env?: LaunchEnv, deps?: { spawn?: SpawnFn }): Promise<LaunchResult>;
type SpawnFn = typeof import('node:child_process').spawn;   // minimal structural subset is fine
```
`env` defaults to the real environment (`process.platform`, `process.env`, `fs.existsSync`, a PATH-scanning `which`); `deps.spawn` is an additive third parameter to inject a fake (the spec's two-parameter signatures stay valid). Spawn contract: `detached: true`, `stdio: 'ignore'`, `unref()`; a step counts as launched when the child emits `spawn`, as failed on `error` (e.g. ENOENT). `index.ts` exports: `planTerminal`, `planAppWindow`, `openTerminal`, `openAppWindow`, `detectPlatform`, and the types.

**Steps**
- [ ] Tests first with a fake `spawn` (event-emitter child): success on the first step -> `{status:'launched', via}`; ENOENT on step 1 then success on step 2 -> `launched` via step 2 (`WL-8: a failed first step falls through to the next`); all fail -> `unsupported` with every failure reason present in `reason` (`WL-8: all steps failing yields unsupported with the failure reasons`); assert detached/ignore/unref were used. `WL-2: linux without DISPLAY/WAYLAND_DISPLAY returns unsupported with the original command line, correctly quoted, as fallback` (the fallback string, executed with real `sh`, reproduces the argv — reuse the T20 round-trip approach). `WL-4: openAppWindow returns unsupported with the URL as fallback for non-local URLs` and never spawns.
- [ ] Never throw for expected failures (return `unsupported`); implement; commit.

---

# Part D: `@loopwork/eventlog` (EL-1 .. EL-10)

Tests live in `packages/eventlog/test/`. Type-only import from `@loopwork/graph`: `import type { Flow, JsonValue } from '@loopwork/graph'` (depcruise rule 2). `fold.ts` must never import `pg`. Postgres tests need `LOOPWORK_TEST_DATABASE_URL` (compose file from T07); the helper fails with a clear message when it is unset, never skips.

## T24: Event types, `EventStore` interface, errors

**Criteria:** none directly (supports every EL criterion).
**Depends on:** T03, T18.

**Files:** `packages/eventlog/src/events.ts`, `packages/eventlog/src/store.ts`, `packages/eventlog/test/events.test.ts`.

**Interfaces** (exactly as in `SPEC-event-log.md`)
```ts
export type NewEvent; LoopworkEvent; RunStatus; RunRow; 
export const EVENT_TYPES: readonly [ /* all 16 type names */ ];
export interface EventStore { create; append; read; subscribe; getRun; listRuns }
export class SeqConflictError extends Error { readonly code = 'E_SEQ_CONFLICT' }
export class RunClosedError extends Error { readonly code = 'E_RUN_CLOSED' }
export class RunExistsError extends Error { readonly code = 'E_RUN_EXISTS' }
export class UnknownRunError extends Error { readonly code = 'E_RUN_NOT_FOUND' }
export class InvalidEventError extends Error { readonly code = 'E_BAD_EVENT' }
```

**Steps**
- [ ] Tests first: `EVENT_TYPES` contains every `type` of the `NewEvent` union (compile-time exhaustiveness helper plus a runtime list), each error class carries its stable `code` and `instanceof` works across `Error` subclassing.
- [ ] Implement; commit.

## T25: Status rules (pure)

**Criteria:** EL-4 (part: the pure rule).
**Depends on:** T24.

**Files:** `packages/eventlog/src/status.ts`, `packages/eventlog/test/status.test.ts`.

**Interfaces**
```ts
export function nextStatus(current: RunStatus | undefined, e: NewEvent | LoopworkEvent): RunStatus;
export function assertAppendAllowed(current: RunStatus, lastAttempt: number, events: NewEvent[]): void;  // throws RunClosedError / InvalidEventError
```
Rules: `RunCreated` -> `queued`; `RunStarted` -> `running` (from `queued`, `running`, or from `failed` only when `attempt` is higher than the last attempt); `RunSucceeded` -> `succeeded`; `RunFailed` -> `failed`; `RunCancelled` -> `cancelled`; any other append after a terminal state is rejected with `E_RUN_CLOSED`, including events in the same batch after a terminal event, except the explicit-resume `RunStarted` after `failed`.

**Steps**
- [ ] Tests first: `EL-4: after a terminal event appends are rejected with E_RUN_CLOSED` as a table over (status, event) pairs; `EL-4: RunStarted with a higher attempt on a failed run is accepted and flips status to running`; same-or-lower attempt on failed rejected; `succeeded`/`cancelled` never reopen.
- [ ] Implement; commit.

## T26: `MemoryStore` and the shared contract suite

**Criteria:** EL-1, EL-2, EL-4, EL-5.
**Depends on:** T25.

**Files:** `packages/eventlog/src/memory-store.ts`, `packages/eventlog/test/store-contract.ts` (exports `runStoreContract`; not itself a `*.test.ts`), `packages/eventlog/test/memory-store.test.ts`.

**Interfaces**
```ts
export class MemoryStore implements EventStore { constructor(opts?: { now?: () => Date; pollMs?: number }) }
export function runStoreContract(name: string, makeStore: () => Promise<{ store: EventStore; dispose(): Promise<void> }>): void;   // registers describe/it blocks
```
`subscribe` accepts `pollMs` (default 100) and ends cleanly when the signal aborts (also when already aborted). `append` validates event `type` against `EVENT_TYPES` (`InvalidEventError`) and `expectedSeq` against `lastSeq`.

**Steps**
- [ ] Tests first, inside `runStoreContract` (this suite is reused by T30 for Postgres, so each assertion must hold for any correct store): `EL-1: create/append/read return events in ascending seq with gapless seq starting at 1`, `EL-1: limit and fromSeq are honored`, `EL-1: create fails when runId exists`; `EL-2: stale expectedSeq throws SeqConflictError and writes nothing` (also a batch whose second event is invalid writes nothing); `EL-4: appends after a terminal event reject with E_RUN_CLOSED, explicit-resume RunStarted accepted and getRun status becomes running`; `EL-5: subscribe delivers history then live events in order with no duplicates or gaps and ends on abort` (use small `pollMs`, append concurrently with a reader); `getRun`/`listRuns` (newest first, `status` filter, `limit`, `before`) assertions. Then `memory-store.test.ts` calls `runStoreContract('MemoryStore', ...)`.
- [ ] Implement `MemoryStore` (assigns `ts` from the injected clock, computes projection via `nextStatus`); commit.

## T27: `foldRun` / `applyEvent`

**Criteria:** EL-7.
**Depends on:** T25.

**Files:** `packages/eventlog/src/fold.ts`, `packages/eventlog/test/fold.test.ts`.

**Interfaces**
```ts
export type RunState = { status: RunStatus; flow?: Flow; lastSeq: number; attempt: number; failure?: {...};
  nodes: Map<string, { started: number; succeeded: number; failed: number; inFlight: Set<string> }>;
  edges: Map<string, { emitted: number; consumed: number }>;
  frames: Map<string, { iterationsStarted: number; iterationsEnded: number; active: Set<string>; elapsedMs: number; exited: boolean }>;
  sourcesCompleted: Set<string>; committed: Set<string> /* `${node}\u0000${itemId}` */; recentErrors: {...}[] /* max 50 */;
  sideEffects: Map<string, JsonValue> };
export function emptyRunState(): RunState;
export function applyEvent(state: RunState, e: LoopworkEvent): RunState;   // mutates and returns the state it owns
export function foldRun(events: Iterable<LoopworkEvent>): RunState;       // reduce(applyEvent, emptyRunState())
export function statusOf(state: RunState): RunStatus;
export function sideEffectKey(node: string, itemId: string, key: string): string;
```
Edge ids use the string format `${from.node}.${from.port}->${to.node}.${to.port}` computed locally over the flattened scoped edges (the package may only `import type` from graph, so `edgeId` cannot be called; a comment must say the format is defined in `SPEC-graph-model.md`).

**Steps**
- [ ] Read (read-only) `SPEC-engine-core.md` for how frame boundaries and `StepSucceeded.outputs` map onto edges; ask via the inbox if ambiguous rather than guessing.
- [ ] Tests first with hand-built logs: `EL-7: foldRun is deterministic (same events, same state)` (deep-equal of two folds); `EL-7: foldRun(a ++ b) equals applying b with applyEvent to foldRun(a)` over several split points; per-field assertions (counts, inFlight set add/remove, committed set from `StepSucceeded`, frame iteration and exit, `recentErrors` bounded to 50 keeping the latest, side effects map, `attempt` from `RunStarted`, `failure` from `RunFailed`, `lastSeq`).
- [ ] Fold performance (spec statement, not an EL id): a test named `fold: 1M events fold in under 5 s` (generate events lazily, assert elapsed < 5000 ms). If generation cost threatens the 90 s `check:task` budget, make the generator cheaper, do not weaken the number.
- [ ] Implement; commit.

## T28: EL-6 property test (projection equals fold)

**Criteria:** EL-6 (memory store).
**Depends on:** T26, T27.

**Files:** `packages/eventlog/test/valid-log.ts` (seeded PRNG + generator of random VALID logs: legal lifecycle with resumes, nested frames, steps, terminal events), `packages/eventlog/test/store-contract.ts` (add the EL-6 case), `packages/eventlog/test/valid-log.test.ts`.

**Interfaces:** `export function genValidLog(seed: number, opts?: { maxEvents?: number }): NewEvent[]`; the contract suite gains `EL-6: runs projection always equals statusOf(foldRun(events))` that, for N seeds (e.g. 200), appends a generated log in random-sized batches and compares `getRun(runId).status` (and `lastSeq`) to `statusOf(foldRun(await collect(store.read(runId))))` after every batch. No new dependency (own PRNG).

**Steps**
- [ ] Tests first: `valid-log.test.ts` asserts the generator only produces logs accepted by `assertAppendAllowed` (guards the generator itself); then add EL-6 to the contract suite and run it against `MemoryStore`.
- [ ] Commit.

## T29: Migrations, `migrate`, Postgres test helper

**Criteria:** EL-9.
**Depends on:** T24, T07.

**Files:** `packages/eventlog/migrations/001_init.sql` (exactly the schema in the spec), `packages/eventlog/src/migrate.ts`, `packages/eventlog/test/pg-helper.ts`, `packages/eventlog/test/migrate.pg.test.ts`.

**Interfaces**
```ts
export function migrate(pool: Pool, opts?: { dirs?: string[] }): Promise<{ applied: number[] }>;   // dirs = extra dirs (e.g. @loopwork/runtime); this package's migrations/ is always included
export class SchemaTooNewError extends Error { readonly code = 'E_SCHEMA_NEWER' }
export class MigrationConflictError extends Error { readonly code = 'E_MIGRATION_CONFLICT' }
// pg-helper.ts
export function withTestSchema(): Promise<{ pool: Pool; schema: string; dispose(): Promise<void> }>;  // throwaway schema per test file, pool pinned to it via search_path
```
Behavior: files `NNN_name.sql` across all dirs applied in numeric order, each in a transaction with its `schema_migrations` row; takes `pg_advisory_lock` on a dedicated client for the whole run; idempotent; throws `SchemaTooNewError` when `schema_migrations` holds a version no known file declares; duplicate version numbers across dirs throw `MigrationConflictError`. Applied migration files are never edited.

**Steps**
- [ ] Tests first (`migrate.pg.test.ts`): `EL-9: migrate is idempotent` (second call applies nothing), `EL-9: concurrent callers are serialized` (4 simultaneous `migrate` calls on a fresh schema: exactly one applies, none errors, final state consistent), `EL-9: refuses a newer-than-known schema` (insert a higher version row first), `EL-9: extra dirs are applied in numeric order across dirs` (temp dir with `002_extra.sql`), duplicate-version conflict.
- [ ] `withTestSchema` reads `LOOPWORK_TEST_DATABASE_URL`, throws a clear error if unset (no skip), creates `t_<random>` schema, drops it on dispose. Resolve the migrations directory relative to the compiled module (`import.meta.url`) so it works from `src` (vitest) and `dist`; ensure `package.json` `files` includes `migrations/`.
- [ ] Run against the compose Postgres (`docker compose -f docker-compose.test.yml up -d --wait`), then `pnpm --filter @loopwork/eventlog test:pg`; commit.

## T30: `PgStore` and the public API

**Criteria:** EL-1, EL-2, EL-4, EL-5, EL-6 (Postgres runs of the shared suite).
**Depends on:** T28, T29.

**Files:** `packages/eventlog/src/pg-store.ts`, `packages/eventlog/src/index.ts` (final), `packages/eventlog/test/pg-store.pg.test.ts`.

**Interfaces**
```ts
export class PgStore implements EventStore {
  constructor(pool: Pool, opts?: { pageSize?: number /* default 5000 */; pollMs?: number /* default 100 */; now?: () => Date });
}
```
`index.ts` exports: all event/store types, `EVENT_TYPES`, the error classes, `MemoryStore`, `PgStore`, `migrate` (+ its errors), `foldRun`, `applyEvent`, `emptyRunState`, `statusOf`, `sideEffectKey`, `RunState` types.

**Steps**
- [ ] Tests first: `pg-store.pg.test.ts` runs `runStoreContract('PgStore', ...)` over `withTestSchema()` + `migrate` (this executes the EL-1, EL-2, EL-4, EL-5 and EL-6 cases against Postgres; the test names come from the shared suite, so the IDs are already mapped).
- [ ] Implement: `create` inserts the `runs` row and event 1 in one transaction; `append` is one transaction: `select last_seq from runs where run_id = $1 for update`, compare with `expectedSeq` (`SeqConflictError` with nothing written), `assertAppendAllowed`, multi-row insert via `unnest`, update the `runs` projection (`status` via `nextStatus`, `last_seq`, `updated_at`) in the same transaction; payload is JSON of everything except `runId/seq/ts/type`; `read` pages by keyset on `(run_id, seq)` (`pageSize`, never `OFFSET`); `subscribe` polls every `pollMs` and ends on abort; `listRuns` ordered by `created_at desc` with `before` keyset.
- [ ] `fold.ts` and `status.ts` must not import `pg` (depcruise or a simple import check in the pg test is acceptable evidence; depcruise from T06 already forbids cycles).
- [ ] Write `index.ts`; `pnpm --filter @loopwork/eventlog build` clean; `pnpm --filter @loopwork/eventlog test:pg` green against the compose Postgres; commit.

## T31: Postgres-only criteria: concurrency, load, constant-memory reads

**Criteria:** EL-3, EL-8, EL-10.
**Depends on:** T30.

**Files:** `packages/eventlog/test/pg-store-load.pg.test.ts`, `docs/develop/measurements/event-log.md`.

**Steps**
- [ ] `EL-3: two concurrent appenders with the same expectedSeq, exactly one succeeds` (loop e.g. 50 rounds with `Promise.allSettled`; the loser rejects with `SeqConflictError`, log has no duplicate or missing seq).
- [ ] `EL-8: appending 100k events in batches of 500 completes in under 20 s`; assert `< 20_000` ms and record the measured number (several runs, median) in `docs/develop/measurements/event-log.md`. The brief says to record it "in the spec", but `SPEC-event-log.md` is on the do-not-edit list: write the question to the inbox ("please copy the measured EL-8 number into SPEC-event-log.md and decide whether to recalibrate the 20 s target") and keep the number in the measurements file.
- [ ] `EL-10: reading a long run uses constant memory`: wrap the pool so each events-page query's row count is recorded (a spy on `pool.query`, no hook in production code); with `pageSize` set small (e.g. 1,000) over a run of 50,000 events assert every page has at most `pageSize` rows, the number of page queries equals `ceil(n / pageSize)`, no SQL text contains `OFFSET`, and the consumer can stop mid-iteration with no further page fetched. Note in the test header that the property is size-independent and the 1M-event figure from the spec is not materialized to keep the pg stage short; flag this in the task's commit message so the reviewer can ask for the 1M run.
- [ ] Commit.

---

# Part E: Wrap-up

## T32: Criteria map and full verification

**Criteria:** SC-1, SC-4 (final timing check).
**Depends on:** T09, T23, T31 (everything).

**Files:** `scripts/criteria-map.mjs`, `scripts/test/criteria-map.test.ts`.

**Interfaces:** `export function findUnmappedCriteria(opts: { ids: string[]; files: Map<string, string> }): string[]`; CLI `node scripts/criteria-map.mjs` lists each ID with the test files that name it and exits non-zero if any ID has none. Expected IDs: `SC-1..SC-7`, `GM-1..GM-9`, `WL-1..WL-8`, `EL-1..EL-10`. A criterion counts as mapped only when a file matching `*.test.ts` or `store-contract.ts` contains `it('<ID>:` / `test('<ID>:` (single, double or backtick quotes). The criteria-map test itself is excluded from the scan so it cannot satisfy its own list.

**Steps**
- [ ] Tests first (`it('SC-1: ...')` style is not needed here): unit tests for `findUnmappedCriteria` (missing ID reported, quote styles, the self-exclusion, `store-contract.ts` counted), then a repo-level test asserting the real tree has zero unmapped IDs.
- [ ] Full verification run, record results in the commit message and in the final report: `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `time pnpm check:task` (must be < 90 s, SC-4; if it is slower, move work to CI per CONSTRAINTS.md only by making checks faster, never by removing them), `docker compose -f docker-compose.test.yml up -d --wait && LOOPWORK_TEST_DATABASE_URL=postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test pnpm test:pg`, `scripts/floor-guard.sh` with `LOOPWORK_BASE_REF=0d6c7bf`, `node scripts/criteria-map.mjs`.
- [ ] Confirm `git diff 0d6c7bf --stat` touches nothing in the do-not-change list (`CONSTRAINTS.md`, `SPEC-*.md`, `CAPABILITY-MAP.md`, `docs/adr/*`, `docs/PLAN.md`) and creates no package beyond `graph`, `windows`, `eventlog`.
- [ ] Commit. Stop before the PR step (no remote exists): raise the missing remote as a human interrupt.
