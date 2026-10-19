# Plan: engine-core-1-fold

Spec (verbatim brief): `docs/develop/specs/engine-core-1-fold.md`
Source of truth (a spec wins over the brief): `SPEC-event-log.md` (Events + foldRun sections), `SPEC-engine-core.md`.
Design pass: `.develop/inbox/questions/20261014-fold-per-instance-frames.md` (main repo; `.develop/` is gitignored in the worktree).
Branch `feat/engine-core-1-fold`, cut from `b1c5854` (`origin/main`). Slice 1 of 6 of stacked engine-core PRs; PR targets `main`, human merges.

Read-only for every task: `CONSTRAINTS.md`, `SPEC-*.md`, `CAPABILITY-MAP.md`, `docs/adr/*`, Postgres migrations, store contracts.

## Conventions

- TDD, proportionate: per new reading write a handful of focused fold tests first (`it('EL-7: <what it proves>', ...)`; keep the `EL-7:` prefix so `node scripts/criteria-map.mjs` still maps), watch them fail, implement. No hostile-input matrices.
- ESM, strict TS, `.js` import suffixes, named exports, no `any`, no suppression comments, no `console.*`.
- Footprint = exact files a task may modify. All three tasks touch `fold.ts` and `fold.test.ts`, so they are strictly sequential (T1 -> T2 -> T3); no parallelism.
- Every task leaves `pnpm --filter @loopwork/eventlog test` and `pnpm typecheck` green on its own commit.
- Test-Change-Reason (floor-guard): floor-guard's skipped/deleted-test rule trips on any REMOVED or REWRITTEN `it(` line (a retitle counts). Prefer keeping the existing title and changing only the body. Where a title must change (T3), the commit message needs a non-empty trailer line, e.g.
  `Test-Change-Reason: <old title> rewritten for the FrameExited.outputs reading (SPEC-event-log.md foldRun)`.
  Commits of T1/T2/T3 that touch an `it(` line carry one; keep titles stable in T1/T2 so it is only a safety net there.
- Commit per task, message names the task id; end with the attribution trailer the environment demands.

## Consumers of the changed fields (grep: `inFlight|\.frames|frames|FrameExited|iterationsStarted|exited|RunState`, excluding node_modules/dist/lockfiles/.develop/runs)

Only `packages/eventlog` reads them. No other package (`graph`, `windows`) or script touches `RunState`.

| Consumer | Reads | Action |
|---|---|---|
| `packages/eventlog/src/fold.ts` | defines `RunState`, writes `nodes[].inFlight`, `frames`, handles `FrameExited` | T1, T2, T3 |
| `packages/eventlog/src/events.ts` | defines `FrameExited` | T1 |
| `packages/eventlog/test/fold.test.ts` | `nodeOf(...).inFlight` (l.223-255), `frameOf` (l.74, 467-482), `FrameExited` in the main log (l.124, 134) and the while test (l.384-446) | T1, T2, T3 |
| `packages/eventlog/test/valid-log.ts` (l.94) | emits `FrameExited` without `outputs` (valid: field optional) | no change |
| `packages/eventlog/test/store-contract.ts` (l.8, 480) | `foldRun`/`statusOf` only (status, not frames/inFlight) | no change |
| `packages/eventlog/test/index.test.ts`, `src/index.ts` | export `RunState` type by name only | no change |
| `packages/eventlog/test/events.test.ts` (l.34) | `EVENT_TYPES` name list | no change |
| `packages/eventlog/src/pg-store.ts` (l.77) | runtime validation is the event TYPE only (`EVENT_TYPES.includes`), no payload-shape validation; `outputs?` needs no runtime check | no change |
| `SPEC-run-service.md` (l.90-92), `SPEC-ui-viewer.md`, `SPEC-engine-core.md` | describe future views/engine of these fields | specs, read-only; later slices adapt |
| `docs/develop/plans/phase1-foundation.md` | historical record of the old shapes | leave as is |

## Acceptance-criteria coverage matrix

Criteria IDs for this bundle (brief bullets, in order): AC1 FrameExited.outputs type/validation; AC2 per-instance frames; AC3 inFlight Map + willRetry keep + consumed; AC4 outputs-based emissions; AC5 tests updated, EL-6/EL-7/perf hold; AC6 consumers + `pnpm check:task`.

| ID | Tasks |
|---|---|
| AC1 | T1 (type; runtime validation: none exists beyond event type, verified, nothing to add) |
| AC2 | T1 |
| AC3 | T2 |
| AC4 | T3 |
| AC5 | T1, T2, T3 (each updates the tests its reading changes); T3 runs EL-6/EL-7/perf |
| AC6 | T3 (grep above shows no consumer outside eventlog; final `check:task` + `criteria-map`) |

## Dependency DAG

```
T1 -> T2 -> T3
```

## T1 - FrameExited.outputs type + per-instance frame state

**Covers:** AC1, AC2, AC5 (frame tests).
**Depends on:** none.

**Files**
- `packages/eventlog/src/events.ts`
- `packages/eventlog/src/fold.ts`
- `packages/eventlog/test/fold.test.ts`

**Interfaces**
- `events.ts`: `FrameExited` becomes `{ type: 'FrameExited'; node: string; itemId: string; reason: 'input-done' | 'condition' | 'success' | 'retries-exhausted'; outputs?: { port: string; itemId: string; value: JsonValue }[] }` (same output element shape as `StepSucceeded.outputs`).
- `fold.ts`: `RunState['frames']` becomes `Map<string, FrameState>` with
  `type FrameInstance = { iteration: number; elapsedMs: number; breached: boolean }` and
  `type FrameState = { iterationsStarted: number; iterationsEnded: number; exitedCount: number; active: Map<string, FrameInstance> }`.
  `frameOf(state, id)` (internal) creates `{ 0, 0, 0, new Map() }`. Remove the old `elapsedMs`/`exited` fields and `active: Set`.

**Steps**
- [ ] Tests first in `fold.test.ts` (update the existing `EL-7: per-frame iterations, active set, elapsedMs and exited` body, keep its title; add the rest as new `it('EL-7: ...')`): (a) after `FrameEntered` for A and B, `frames.get('loop').active` has two instances each `{ iteration: 0, elapsedMs: 0, breached: false }`, `exitedCount: 0`; (b) `IterationStarted`/`IterationEnded` on A advance only A (`iteration`, `elapsedMs` accumulates across two `IterationEnded`) while B stays untouched, node-level `iterationsStarted/Ended` still aggregate; (c) `BudgetExceeded` on A sets `breached: true` on A only; (d) `FrameExited` for A deletes A from `active` and `exitedCount` becomes 1, B remains; final log: `active` empty, `exitedCount: 2`; (e) events for an unknown instance (IterationStarted/Ended/BudgetExceeded with no `FrameEntered`) do not throw and do not create an instance (instance ops are no-ops when absent; `iterationsStarted/Ended` and `exitedCount` still count).
- [ ] `events.ts`: add the optional `outputs` field to the `FrameExited` member of `NewEvent`.
- [ ] `fold.ts`: new state types; `FrameEntered` -> `frameOf(...).active.set(itemId, { iteration: 0, elapsedMs: 0, breached: false })` (keep the `consume` call); `IterationStarted` -> `iterationsStarted++`, and if the instance exists set `iteration = e.iteration`; `IterationEnded` -> `iterationsEnded++`, instance `elapsedMs += e.elapsedMs` if it exists; `BudgetExceeded` -> instance `breached = true` if it exists (it currently falls through `default`; add a case); `FrameExited` -> `active.delete(itemId)`, `exitedCount++`. KEEP the existing `reason === 'condition'` emit for now (removed in T3) so the repo stays working.
- [ ] Run `pnpm --filter @loopwork/eventlog test`, `pnpm typecheck`, `pnpm lint`. Commit `T1: ...` (add `Test-Change-Reason:` only if an `it(` title changed).

## T2 - inFlight as Map<itemId, attempt>, kept on willRetry

**Covers:** AC3, AC5 (node tests).
**Depends on:** T1 (same files; sequential).

**Files**
- `packages/eventlog/src/fold.ts`
- `packages/eventlog/test/fold.test.ts`

**Interfaces**
- `fold.ts`: `RunState['nodes']` value type `{ started: number; succeeded: number; failed: number; inFlight: Map<string, number> }`; `nodeOf` initialises `inFlight: new Map()`.

**Steps**
- [ ] Tests first: update `EL-7: per-node started/succeeded/failed counters and inFlight add/remove` (l.223-255; keep the title) to Map readings: `inFlight: new Map([['src.out#0', 1], ...])`; the resumed re-run (`attempt 2`) shows value `2`; the `mFailed` checkpoint (StepFailed with `willRetry: true` in the existing log, see l.243) now KEEPS the item with its last started attempt; the `mDone` checkpoint empties it. Add small new `it('EL-7: ...')` tests: (a) `StepFailed{willRetry:true}` keeps the item, a following `StepStarted{attempt+1}` updates the attempt, `StepSucceeded` removes it; (b) `StepFailed{willRetry:false}` removes it; (c) `consumed` still counts only `attempt === 1` (a retry `StepStarted{attempt:2}` does not increment the edge's `consumed`). Update the remaining `inFlight: new Set(...)` literals in that test (l.252-255) to Maps.
- [ ] `fold.ts`: `StepStarted` -> `n.inFlight.set(e.itemId, e.attempt)`; `StepSucceeded` -> `delete`; `StepFailed` -> `if (!e.willRetry) n.inFlight.delete(e.itemId)`. `failed++` and `recentErrors` unchanged.
- [ ] Verify the existing main log still satisfies the new reading (adjust the log only if a `willRetry:true` failure must be followed by a restart to reach the intended end state; comment why).
- [ ] Run `pnpm --filter @loopwork/eventlog test`, `pnpm typecheck`, `pnpm lint`. Commit `T2: ...`.

## T3 - frame emissions from FrameExited.outputs; final verification

**Covers:** AC4, AC5 (EL-6/EL-7/perf), AC6.
**Depends on:** T2 (same files; sequential).

**Files**
- `packages/eventlog/src/fold.ts`
- `packages/eventlog/test/fold.test.ts`

**Interfaces**
- No signature changes. `FrameExited` handling: `for (const o of e.outputs ?? []) emit(lookup, `${e.node}.${o.port}`)`; delete the `if (e.reason === 'condition') emit(lookup, `${e.node}.out`)` line and its comment.

**Steps**
- [ ] Tests first. Rewrite `EL-7: while/until count emitted on the frame out edges only at FrameExited{condition}, not per iteration` (l.384-446): its `FrameExited` events now carry `outputs: [{ port: 'out', itemId: `${first}>W.out#0`, value: 1 }]` (item id convention `${input}>${node}.${port}#${k}` from `SPEC-event-log.md`); the consumer `stepStarted('snk', ...)` must use the same item id so `producerOf` resolves to `W.out`. Retitle to `EL-7: while/until count emitted on the frame out edges from FrameExited.outputs, not per iteration or by reason` (needs `Test-Change-Reason:` trailer, see Conventions). Add new `it('EL-7: ...')` tests: (a) a ZERO-iteration `while`: `FrameEntered` then `FrameExited{condition, outputs:[out]}` counts `emitted: 1` on `W.out->snk.in`; (b) a `retry` frame with `onExhausted: 'emit-error'`: `FrameExited{retries-exhausted, outputs:[{port:'error', itemId: `${in}>${frame}.error#0`}]}` counts `emitted: 1` on the `F.error->...` edge (build a small retry flow with an `error` edge); (c) `FrameExited{condition}` WITHOUT `outputs` emits nothing (reason no longer special-cased); (d) the foreach main-log `FrameExited{input-done}` (no outputs) still emits nothing itself while `loop.out` edge counts continue to come from the aliased body exit (existing edge tests stay green untouched).
- [ ] Check the nested-alias test (l.325-383) and the main log's edge expectations; adjust fixtures only if they relied on `reason: 'condition'` (grep says only the while test does).
- [ ] `fold.ts`: apply the `FrameExited` change above.
- [ ] Final checks from the worktree root, Node 22 first on PATH: `pnpm --filter @loopwork/eventlog test` (EL-6 property test via the contract suite, EL-7 determinism/split tests, `fold: 1M events fold in under 5 s` unchanged), `node scripts/criteria-map.mjs`, `LOOPWORK_BASE_REF=$(git rev-parse origin/main) pnpm check:task` (typecheck, lint, tests with coverage incl. changed-line >= 80%, floor-guard, depcruise).
- [ ] Commit `T3: ...` with the `Test-Change-Reason:` trailer.

## Out of scope for this bundle

Engine code, new event types, SQL migrations, spec edits, `SPEC-run-service.md` view mapping, `valid-log.ts` generator changes (optional `outputs` needs none).
