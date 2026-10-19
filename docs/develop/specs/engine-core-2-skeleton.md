---
mode: needs_implementation
title: engine-core slice 2 of 6 — engine skeleton (@loopwork/engine: registry, builtins, channel, scheduler, recorder, plain steps, fencing)
branch: feat/engine-core-2-skeleton
base: 6acd3ce9662776bbb15884785cef886ef67cb23a
default_branch: main
created_by: claude-code
---

## What
Create the new workspace package `packages/engine` (`@loopwork/engine`) implementing the non-frame core of `SPEC-engine-core.md`
(settled in PR #9; fold support merged in PR #10): `executeRun` for flows made of plain nodes only (`source -> map* -> sink`),
no frames yet (foreach/retry/while/until are slices 3-4), no resume (slice 5), no cancellation grace / pg / bench (slice 6).

In scope (see the spec's Project Structure/Contract/Semantics):
- `NodeRegistry` (source/map/sink/predicate registration, `has`, `names`) and `createBuiltins()` with the in-memory built-ins only:
  `source: range, fromInput, fromFile`; `map: identity, sleep, tag, failEvery, increment`; `sink: discard, logLine` (logLine must not write to
  stdout: CONSTRAINTS forbids stdout writes in packages/*; use an injectable writer, default no-op); `predicate: lessThan, truthy`.
  NOT `pgIdempotent` (slice 6).
- Bounded async channel (backpressure), per-node worker pool honoring node `concurrency` (default 1), global `maxInFlight` cap.
- Batching event recorder (flush by `maxEvents`/`maxMs`; always flush before a sink reports success and before a terminal event / return) using `expectedSeq`; `SeqConflictError` -> stop all work and return `{status:'fenced'}`.
- `executeRun(opts)`: reads the log, folds it, appends `RunStarted{workerId, attempt: state.attempt+1}`, drives the flow, appends terminal event; returns `RunOutcome` (`succeeded | failed{step|budget|internal} | cancelled | fenced`). A plain step failure outside a retry frame fails the run (`RunFailed{reason:'step', node}` with `StepFailed` in the log). Cancellation via `opts.signal` may be minimal here (stop scheduling, flush, `RunCancelled`); the 5 s grace/EC-13 is slice 6.
- `StepContext` with `idempotencyKey`; `ctx.now()/random()` may be a plain logged SideEffect pass-through (replay is slice 5).
- Package wiring: tsconfig references, vitest project membership, dependency-cruiser architecture rules (engine may depend on `@loopwork/graph` and `@loopwork/eventlog` only, per CONSTRAINTS.md), `check:*` still pass, README mention.

## Why
Slice 2 of the stacked engine-core PRs (docs/PLAN.md phase 1, build order: engine-core after event-log). Design decisions are recorded in SPEC-engine-core.md and the PR #9 description; the spec wins over this brief.

## Acceptance criteria
- EC-1 `source -> map -> sink` flow over N items: `StepSucceeded` count equals N per node; run `succeeded`.
- EC-2 Backpressure: with a sink slower than the source, the source's emitted-minus-consumed gap never exceeds `channelCapacity + concurrency`; a 100k-item run against a DISCARDING test store (test helper, not MemoryStore) completes under `--max-old-space-size=256` (keep this test in the `*.timed.test.ts` last-run group or otherwise within the 90 s `check:task` budget; if 100k is too slow for check:task use a smaller N in the unit test and keep 100k for `bench:stream`, which lands in slice 6 — state which you chose).
- EC-3 Concurrency: a node with `concurrency: k` never has more than k steps in flight and reaches k when work is available; `maxInFlight` caps the total.
- EC-9 A failing plain step fails the run with `reason:'step'` and the node id; its `StepFailed` is in the log.
- EC-14 A second executor appending with a stale `expectedSeq` makes the first return `fenced` and stop issuing steps.
- Package builds, typechecks, lints; depcruise rules for the new package pass; `node scripts/criteria-map.mjs` maps EC-1, EC-2, EC-3, EC-9, EC-14 to named tests and does not regress the existing 34; `pnpm check:task` stays under 90 s.

## Files changed
New: `packages/engine/**` (src/{execute,registry,builtins,channel,scheduler,recorder}.ts, index.ts, tests). Tooling touches only as needed to register the package (workspace/tsconfig/vitest/depcruise/README/criteria-map expected ids if the script lists them).

## Interfaces
Exactly the Contract section of SPEC-engine-core.md (NodeRegistry, StepContext, ExecuteOptions incl. `workerId`, `cancelGraceMs?`, RunOutcome). Public exports from `src/index.ts`.

## How to verify
`LOOPWORK_BASE_REF=$(git rev-parse origin/main) pnpm check:task`; `pnpm --filter @loopwork/engine test`; `pnpm check:arch`; `node scripts/criteria-map.mjs`.

## Do not change
`CONSTRAINTS.md`, specs (raise a design question in `.develop/inbox/questions/` if a spec point blocks you), eventlog/graph public contracts, Postgres schema.

## Open questions
None blocking. Test volume: proportionate (focused tests per EC, no hostile-input matrices); repair cap 1; adversarial = mutation spot-check only; split into the smallest sensible tasks (expect ~6-8: channel, recorder, registry+builtins, scheduler/worker pool, executeRun happy path + step failure, fencing, tooling wiring). PR targets `main`, human merges.
