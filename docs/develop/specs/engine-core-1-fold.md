---
mode: needs_implementation
title: engine-core slice 1 of 6 — eventlog fold changes (per-instance frames, inFlight attempts, FrameExited.outputs)
branch: feat/engine-core-1-fold
base: b1c585487ce6dcccdee916ce17a149294fae67ba
default_branch: main
created_by: claude-code
---

## What
Change `@loopwork/eventlog` (`events.ts`, `fold.ts`, fold tests, any `RunState` consumer in the repo) to match the settled
`SPEC-event-log.md` (merged in PR #9). No engine code, no new event type, no SQL migration.

## Why
Slice 1 of the stacked engine-core PRs (docs/PLAN.md phase 1; design pass recorded in `.develop/inbox/questions/20261014-fold-per-instance-frames.md`).
The engine needs per-instance frame state and resumable retries before it can be built on the fold.

## Acceptance criteria
- `FrameExited` has optional `outputs?: { port: string; itemId: string; value: JsonValue }[]` (type and any runtime event validation).
- `RunState.frames`: per frame node, `{ iterationsStarted, iterationsEnded, exitedCount, active: Map<itemId, { iteration, elapsedMs, breached }> }`. An instance is created on `FrameEntered`, advanced by `IterationStarted`/`IterationEnded` (`elapsedMs` accumulates), `breached` set by `BudgetExceeded`, and deleted on its `FrameExited` (`exitedCount++`).
- `nodes[n].inFlight` is `Map<itemId, attempt>` (attempt of the latest `StepStarted`); removed on `StepSucceeded` and on `StepFailed{willRetry:false}`; KEPT on `StepFailed{willRetry:true}`. `consumed` still counts only `attempt === 1`.
- Emissions on frame ports other than the aliased body exit (while/until `out`, retry `error`) are counted from `FrameExited.outputs`; the `reason === 'condition'` special case is removed. A zero-iteration `while` and a retry `emit-error` both count their emitted item.
- Existing fold tests are updated to the new readings (use a `Test-Change-Reason:` commit trailer for removed/rewritten `it(` lines so floor-guard accepts them); EL-6/EL-7 properties still hold; `foldRun` over 1M events still under 5 s (EL fold perf test unchanged).
- Anything outside `packages/eventlog` that reads the changed `RunState` fields is updated; all of `pnpm check:task` passes.

## Files changed
`packages/eventlog/src/events.ts`, `packages/eventlog/src/fold.ts` (and its state types), `packages/eventlog/test/fold*.test.ts`, plus any consumer found by grep.

## Interfaces
Exactly the shapes in `SPEC-event-log.md` (Events + foldRun sections). Spec wins over this brief.

## How to verify
`LOOPWORK_BASE_REF=$(git rev-parse origin/main) pnpm check:task`; `pnpm --filter @loopwork/eventlog test`; `node scripts/criteria-map.mjs`.

## Do not change
`CONSTRAINTS.md`, any spec, the Postgres schema/migrations, public store contracts.

## Open questions
None. Test volume: proportionate (a handful of focused fold tests for each new reading, no exotic hostile-input matrix); repair cap 1; adversarial = mutation spot-check only. PR targets `main`, human merges.
