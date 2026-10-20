---
mode: needs_implementation
title: engine-core slice 3 of 6 — foreach + retry frames and the time budget (EC-4, EC-7, EC-8)
branch: feat/engine-core-3-frames
base: docs/engine-core-frames-design
default_branch: main
created_by: claude-code
---

## What
Extend `@loopwork/engine` `executeRun` (packages/engine/src, merged in #11/#12) to run `foreach` and `retry` frames and enforce `maxDurationMs`. `while`/`until` stay rejected as unrunnable (slice 4); resume (slice 5) and cancel grace/pg (slice 6) are out of scope. Base: the docs branch `docs/engine-core-frames-design` (PR #14: spec clarifications for this slice) — stack on it; PR targets that branch until #14 merges.

## Why
Slice 3 of the stacked engine-core PRs. Design decided by the architect pass (summarised here; SPEC-engine-core.md and SPEC-event-log.md on the base branch win over this brief):
- **Execution model:** one mini-executor per frame instance reusing the same wiring: turn today's wiring+pool launch in `execute.ts` into a `runScope({nodes, edges, prefix, feeds, exitTargets, retry?})` closure sharing `ctrl`, `rec`, `emit`, global `limiter`. Scoped ids `prefix + id`, channel keys stay `node.port`; the body entry channel gets `refs = 1` for the frame boundary; the body exit port's targets are the frame's outer `out` targets (the fold aliases `F.<exit>` to `F.out`); an instance is done when its body pools resolve (close-on-last-release cascade). Frame node = a `runPool` over `F.in` with its OWN `createLimiter(concurrency)` (a frame is not a step; never hold a global permit while a body waits for one). Recursion = call back into `runScope`. Keep `frames.ts` free of imports from `execute.ts` (pass callbacks in; no import cycle).
- **Body node concurrency shared across instances:** each scoped body node gets `createLimiter(n.concurrency ?? 1)`, acquired BEFORE the global limiter, always in that order (keeps EC-3 inside bodies).
- **Item ids:** foreach/retry body entry id = instance id unchanged; body outputs `${itemId}>${F.b}.out#k`; error output `${in}>${F}.error#0`.
- **Write-ahead order per instance:** `await rec.ready()` → `FrameEntered` → `IterationStarted{1}` → send entry item and release entry port → wait for body → `IterationEnded{elapsedMs}` → `FrameExited{reason, outputs?}` → only then send `outputs` downstream. foreach has no `outputs` (body exit items reach `out` via their own StepSucceeded). Release EVERY output port of a node (`out`, and `error` for emit-error), not only `${id}.out`.
- **Retry:** only the failed step is re-run. `runStep(item, attempt)` is the single source of the attempt number: `makeCtx(node,itemId,attempt)`, and both `StepStarted` and `StepFailed` read `ctx.attempt` (remove the hardcoded `attempt: 1`). The nearest retry ancestor passes `retry?` down; `willRetry = attempt < maxAttempts`. Backoff `fixed`: baseMs; `exponential`: `min(baseMs * 2 ** (attempt - 1), 60_000)`; the wait runs in the continuation holding NO permit, then the step re-acquires node+global permits (export `runHeld(limiter, handle, item)` from scheduler.ts, used by runPool's worker and the retry path; runPool tests unchanged). Sleep = a promise around global `setTimeout` rejecting on `ctrl.signal` (an abort logs nothing); do NOT use `node:timers/promises` (vitest fake timers don't patch it). Exhaustion: `fail-run` → `StepFailed{willRetry:false}` then `stop({failed, step, node})`; `emit-error` → mark instance exhausted, let the rest of the body drain (do not abort siblings: orphan inFlight entries), then `FrameExited{retries-exhausted, outputs:[error item {message,item}]}` and send to `F.error`; success exits `FrameExited{success}`. Resume seam: the attempt passed to `runStep` should come from `inFlight.get(itemId)+1` when available (slice 5 wires it); if already > maxAttempts go straight to exhaustion.
- **Time budget:** each instance starts `setTimeout(onBreach, maxDurationMs - loggedElapsed)` at IterationStarted (loggedElapsed 0 now), cleared at exit; `elapsedMs` = `Date.now()` minus iteration start in one helper (vitest fakes Date; engine bookkeeping, not replayed; no new ExecuteOptions field). On breach: emit `BudgetExceeded{node:F,itemId,budget:'time',limit,used}` THEN `stop({failed, budget, node:F})`; first-wins comes from the existing emit gate; the global abort covers aborting in-flight steps.
- **Seams for slices 4/5:** per-frame `instances: Map<itemId,{iteration,elapsedMs,timer,exhausted}>` keyed like fold.frames.active; the iteration number is passed in (not hardcoded to 1); body exit target is a parameter; `runStep` takes a starting attempt.
- **Must change first in the skeleton:** `unrunnable` walks bodies recursively, allows foreach and retry, keeps rejecting while/until; extract wiring into `runScope`; entry `refs` seam; release per output port; `makeCtx` takes attempt; scheduler.ts exports `runHeld`.

## Acceptance criteria
- EC-4 `foreach` runs one iteration per input item with the configured body concurrency, and `FrameEntered`/`FrameExited{input-done}` are emitted once per input item (see SPEC-engine-core.md EC-4 wording).
- EC-7 A frame exceeding `maxDurationMs` ends `failed{budget}` with `BudgetExceeded{budget:'time'}`; in-flight step signals are aborted (virtual time via fake timers; a `sleep{ms}` body that ignores time, then assert its `signal.aborted`).
- EC-8 `retry` succeeds on attempt k after k-1 failures with the specified backoff delays (assert the timer delays, `failEvery`/custom failing map, fake timers); exhaustion either fails the run (`fail-run`) or emits on `error` per `onExhausted`.
- No regressions: EC-1/2/3/9/14 and every existing test stay green; `pnpm check:task` stays under 90 s; criteria map gains EC-4, EC-7, EC-8 (and the README/spec text stays accurate).
- Tests: ~8 `it` cases total for the slice, all on `MemoryStore` with built-ins and fake timers (no real sleeps), mutation spot-check only (e.g. flip `willRetry`, the exponential cap, the lost body-limiter ordering).

## Files changed
packages/engine/src/{execute.ts, scheduler.ts, new frames.ts, maybe recorder.ts untouched}, packages/engine/test/{frames-foreach, frames-retry, frames-budget}.test.ts (+ helpers), scripts/criteria-map.mjs + its test body (keep `it` titles), README only if stale.

## Interfaces
SPEC-engine-core.md Contract (unchanged) + the semantics above. `index.ts` export set unchanged except what the spec says.

## How to verify
`LOOPWORK_BASE_REF=$(git rev-parse origin/main) pnpm check:task` (CI's task job needs `pnpm build` first — already in ci.yml; in a fresh clone run `pnpm build` or typecheck before unit tests); `pnpm --filter @loopwork/engine test`; `pnpm check:arch`; `node scripts/criteria-map.mjs`.

## Do not change
CONSTRAINTS.md, specs (raise a question in `.develop/inbox/questions/` instead), eventlog/graph public contracts, the SC-3 dist rule, thresholds/budgets.

## Open questions
None blocking. Proposed tasks (architect): S3-T1 behaviour-preserving refactor (runScope, attempt plumbing, per-port release, runHeld); S3-T2 foreach (frame pool, instance lifecycle events, exit forwarding, shared per-node limiter, unrunnable recursion) → EC-4; S3-T3 retry success path (willRetry, backoffMs, abortable sleep) → EC-8a; S3-T4 retry exhaustion (fail-run, emit-error, error port wiring) → EC-8b; S3-T5 time budget → EC-7; S3-T6 criteria map + README. Test-first per task; repair cap 1; PR stack: keep PRs small (suggested split: 3a = T1 refactor; 3b = T2–T6) — plan the cut at a clean commit boundary.
