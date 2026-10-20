# Spec: engine-core (`@loopwork/engine`)

Depends on: `graph-model`, `event-log`. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Execute a validated `Flow` in-process against any `EventStore`: streaming items, real concurrency, backpressure,
frame semantics (`foreach`, `while`/`until`, `retry`), mandatory-budget enforcement, and **resume from a log**.
It does not know about queues, leases, processes, CLIs or HTTP.

Success: the semantics below hold identically on the in-memory store (fast tests) and Postgres (durable runs).

## Tech Stack

TypeScript, `node:*` only. No runtime dependencies beyond the sibling packages.

## Commands

```
pnpm --filter @loopwork/engine test
pnpm --filter @loopwork/engine bench:stream      # 100k-item in-memory run, prints heap + throughput
```

## Project Structure

```
packages/engine/
  src/execute.ts        executeRun(opts): Promise<RunOutcome>
  src/registry.ts       NodeRegistry, built-in registration
  src/builtins.ts       createBuiltins(): NodeRegistry
  src/channel.ts        bounded async channel (backpressure)
  src/scheduler.ts      per-node worker pool, global in-flight cap
  src/scope.ts          run-scope wiring, recursive frame execution
  src/guards.ts         runnability guard
  src/frames.ts         frame-instance runner + retry/backoff primitives (foreach, retry)
  src/loops.ts          while/until instance runner (condition, iterations, iteration budget)
  src/recorder.ts       batching event writer (flush by count/time)
  src/resume.ts         derives work to redo from RunState   (slice 3-5)
  test/
```

## Contract

```ts
type NodeRegistry = {
  source(name: string, fn: SourceFn): void;       // (ctx, params) => AsyncIterable<JsonValue>
  map(name: string, fn: MapFn): void;             // (item, ctx, params) => Promise<JsonValue | JsonValue[]>   (array = fan-out on `out`)
  sink(name: string, fn: SinkFn): void;           // (item, ctx, params) => Promise<void>
  predicate(name: string, fn: PredicateFn): void; // (state, ctx, params) => Promise<boolean>   for while/until conditions
  has(kind, name): boolean;  names(kind): string[];
  get<K extends NodeKind>(kind: K, name: string): FnByKind[K] | undefined;   // FnByKind: source→SourceFn, map→MapFn, sink→SinkFn, predicate→PredicateFn
};
type StepContext = {
  runId: string; node: string; itemId: string; attempt: number; signal: AbortSignal;
  idempotencyKey: string;            // `${runId}/${node}/${itemId}`; stable across attempts and resumes
  input: JsonValue | undefined;      // run input (sources only)
  now(): number;                     // logged via SideEffect on first call; replayed on re-execution
  random(): number;                  // same
};
type ExecuteOptions = {
  runId: string; store: EventStore; registry: NodeRegistry; signal: AbortSignal;
  workerId: string;                  // recorded in the RunStarted that executeRun appends
  expectedSeq: number;               // the run's lastSeq when this executor took over
  cancelGraceMs?: number;            // default 5000: how long to wait for steps that ignore the signal
  channelCapacity?: number;          // default 64 items per edge
  maxInFlight?: number;              // global cap on concurrently executing steps, default 64
  flush?: { maxEvents: number; maxMs: number };   // default { 500, 50 }
};
type RunOutcome =
  | { status: 'succeeded' } | { status: 'failed'; reason: 'step'|'budget'|'internal'; message: string; node?: string }
  | { status: 'cancelled' } | { status: 'fenced' };   // fenced = SeqConflictError: another executor owns the run; stop quietly
executeRun(opts: ExecuteOptions): Promise<RunOutcome>
```
`executeRun` reads the existing log, folds it, and drives the flow to a terminal event. `executeRun` appends `RunStarted{workerId, attempt: state.attempt + 1}` itself (a run with no prior `RunStarted` is attempt 1). Predicates receive `{runId, node, itemId, signal}` only (no `now`/`random`) and must be pure. The caller (durable-runtime) owns leases and passes `expectedSeq`.

### Built-ins (`createBuiltins()`)

Needed by tests, the exit gate, the GUI's demo flows and `loopwork init`'s sample flow:
`source: range{count,start?}`, `source: fromInput` (emits the elements of the run input array), `source: fromFile{path}` (NDJSON);
`map: identity`, `map: sleep{ms}`, `map: tag{key,value}`, `map: failEvery{n,message}` (deterministic failure injection), `map: increment{by}`;
`sink: discard`, `sink: logLine`, `sink: pgIdempotent{table}` (inserts `idempotencyKey` with `ON CONFLICT DO NOTHING`; used by the exit gate; needs the Postgres pool passed through `registerBuiltins({ pool })`, absent for in-memory tests);
`predicate: lessThan{path,value}`, `predicate: truthy{path}`.

## Semantics

**Streaming.** Each edge is a bounded channel. A producer awaits when the channel is full (backpressure), so a
slow sink stalls the source instead of buffering unboundedly. Every `map`/`sink` node runs up to `concurrency`
steps at once (default 1), and all nodes together never exceed `maxInFlight`. Output order is **completion
order**, not input order; lineage is carried in `itemId`. A body node's `concurrency` is shared across all instances of its frame; a body node of a `foreach` that sets none inherits the frame's `concurrency` (an explicit value still caps it), so `foreach` parallelism is not silently limited to one step at a time. Engine memory is O(channels + in-flight), independent of item count (the store and the resume fold are excluded).
A step's `fn` holds the global `maxInFlight` permit; outbound sends (which may block on a full channel) and the sink flush run after the permit is released. Source and map outputs are write-ahead: logged (`ItemEmitted` / `StepSucceeded{outputs}`) first, then delivered downstream.

**Steps.** `StepStarted` → call `fn` → `StepSucceeded{outputs}` or `StepFailed`. A step is *committed* only when its
`StepSucceeded` is flushed to the store. Anything not in the log is treated as not done.

**ForEach.** One frame instance per item arriving on `in` (up to `concurrency` instances at once): `FrameEntered`, one iteration running `body` on that item, then `FrameExited{input-done}`. Body output items go to `out`. `maxIterations` is trivially satisfied (1); `maxDurationMs` bounds each item's body. The frame is done when `in` is closed and no instance is active (derived, not an event).

**While/Until.** Item on `in` is the initial *state*. Loop: evaluate `condition(state)`; `while` runs the body
while it is true, `until` runs the body until it is true (condition checked **after** each iteration for `until`,
**before** for `while`); the body's `out` item becomes the next state. Emits the final state on `out`, exit
`condition`. Iteration counts against `maxIterations`. Iteration n's body entry item id is `${instanceItemId}>${frame}.iter#${n}`. The final state is logged as `FrameExited.outputs` on `out` (including for a `while` that ran zero iterations).

- `condition` names a registered predicate; the frame's `conditionParams` (if any) is its `params`. A predicate has no `now`/`random`, so re-evaluating it from the logged state on resume is deterministic and logs nothing. A predicate that throws fails the run `failed{reason:'step'}` with the frame's id as `node`.
- Each iteration runs the body in a fresh scope fed one item (the current state). The body must emit **exactly one** item on its exit; any other count (a filtering or fan-out body) fails the run `failed{reason:'step'}` naming the frame. Exception: if an enclosing `retry` frame (`emit-error`) is exhausted before an iteration starts or while it runs, the instance is abandoned so fold drops it. It is checked before every iteration (including the first), and no further iteration starts: exhausted before one starts, the instance logs only `FrameExited{retries-exhausted}` with no outputs (no `IterationStarted`/`IterationEnded`); exhausted while it runs, `IterationEnded` precedes that `FrameExited`.
- `maxIterations` is checked before starting iteration n: if n would exceed it (a `while` still true, an `until` still false after `maxIterations` iterations), append `BudgetExceeded{budget:'iterations', limit:maxIterations, used:maxIterations}` and end the run `failed{reason:'budget'}`. A condition that is satisfied exactly after iteration `maxIterations` is not a breach. `maxDurationMs` spans the whole instance across iterations, as for other frames. `IterationEnded.elapsedMs` of a loop covers the time since the previous mark (instance entry, or the previous `IterationEnded`), so predicate time between iterations is included and the sum over an instance approximates its wall time up to its last completed iteration; predicate time after the last `IterationEnded` (the final condition check) is not logged.
- Iterations of one instance run strictly one after another; instances of the same frame run one at a time per pool (as `retry`). Body nodes without their own `concurrency` inherit the enclosing foreach's, as elsewhere.

**Retry.** Run `body` on the item; on step failure retry up to `maxAttempts` total with `backoff`
(`fixed`: `baseMs`; `exponential`: `baseMs * 2^(attempt-1)`, capped at 60 s). Success exits `success`. A retry re-runs the failed step with `attempt + 1`; committed body steps are not re-run. `attempt` counts executions, including ones interrupted by a crash, and `maxAttempts` bounds it. On
exhaustion exit `retries-exhausted`: `fail-run` ends the run `failed{reason:'step'}`; `emit-error` logs `FrameExited{retries-exhausted, outputs:[{port:'error', itemId:`${in}>${frame}.error#0`, value:{ message, item }}]}` and continues. Plain (non-frame) steps never retry: a failing
step fails the run unless it is inside a `retry` frame. `maxAttempts` bounds each body step `(node, itemId)`; a retry instance runs exactly one iteration (`IterationStarted`/`IterationEnded` 1). In `emit-error` the `item` in the error value is the frame's `in` value, the other body branches complete, and outputs already sent on `out` stand. Instances of a `retry`/`while`/`until` frame run one at a time (wrap the frame in a `foreach` for parallelism); the backoff wait holds no limiter permit.

**Budgets.** `maxIterations` is counted per frame **instance** (per `in` item). `maxDurationMs` is the frame instance's
wall time, accumulated from logged `IterationEnded.elapsedMs` so it survives resume, and enforced by a live timer (logged elapsed plus the current iteration's elapsed time) so a hung iteration still breaches. Instance wall time includes retry backoff and time the body's exit spends blocked on downstream backpressure; `elapsedMs` uses the engine clock and is not replayed. On breach: append
`BudgetExceeded`, abort that frame's in-flight steps through their `signal`, and end the run
`failed{reason:'budget'}`.

**Cancellation.** When `opts.signal` aborts: stop scheduling, abort in-flight steps, flush, append `RunCancelled`,
return `cancelled`. Steps that ignore the signal are not awaited past `cancelGraceMs`. Aborted steps (cancel or budget) log nothing; after `RunCancelled` the recorder is closed and late completions are dropped.

**Determinism.** A step's `fn` may be re-run after a crash. Time and randomness must come from `ctx.now()` /
`ctx.random()`, which are logged as `SideEffect` on the first execution and returned from the log on re-execution. Keys are `now#i` / `random#i` per `(node, itemId)` where i is the call index, shared across attempts; only values flushed before the crash are replayed.
Anything else a step does is its own responsibility; it receives a stable `idempotencyKey` for that purpose.
Guarantee: **at-least-once per step execution, exactly-once per committed step in the log.**

**Resume.** On start, fold the log, then: committed steps are never re-executed (their logged outputs are
re-injected downstream); steps `inFlight` (started, not committed) re-run with `attempt+1`; sources are re-invoked
and the first `emitted` items are not logged again: they are delivered only to consumers that have neither committed nor started them (sources **must be deterministic given `params` and run input**; the
engine keeps a running sha256 per source and compares it with the logged `ItemEmitted` values after those items, failing the run with
`internal` on mismatch); frames re-enter at the logged iteration. A run with a `breached` frame instance is not resumable.

**Recording.** Events are buffered and flushed when `maxEvents` or `maxMs` is reached, and always before: a sink
step reports success, a terminal event, returning from `executeRun`. `append` uses `expectedSeq`; on
`SeqConflictError` the executor stops all work and returns `fenced`.

## Code Style

```ts
export async function runStep(ctx: StepCtx, item: Item): Promise<StepResult> {
  rec.push({ type: 'StepStarted', node: ctx.node, itemId: item.id, attempt });
  try { const out = await fn(item.value, stepContext, params); return commit(item, out); }
  catch (error) { return fail(item, error, attempt); }   // classification (retry frame vs. fail run) happens in the caller
}
```

## Testing Strategy

Almost everything runs on `MemoryStore` with built-ins and virtual time (`vitest` fake timers where a test needs
`sleep`/backoff). Resume tests build a partial log by running the engine, aborting at a chosen event count, then
calling `executeRun` again on the same store. `*.pg.test.ts`: one smoke test per frame kind on Postgres.
`bench:stream` (and EC-2) run against a discarding test store, since `MemoryStore` keeps every event. `bench:stream` is a script (not in CI by default) and prints peak heap.

## Boundaries

- Always: keep `executeRun` free of process/queue concerns; every state change is an event; surface `fenced` rather than retrying a conflict.
- Ask first: adding a node kind or frame kind (needs `graph-model` first); changing completion-order semantics to ordered.
- Never: swallow a step error without an event; mutate the `Flow`; read the wall clock or `Math.random` in engine code paths that a step's logged outcome depends on; let a channel grow unbounded.

## Success Criteria

- **EC-1** A `source → map → sink` flow processes N items; `StepSucceeded` count equals N for each node; run `succeeded`.
- **EC-2** Backpressure: with a sink slower than the source, the source's emitted-minus-consumed gap never exceeds `channelCapacity + concurrency + 1` (the +1 is the write-ahead item the source has logged and parked on a full channel); a 100k-item run against a discarding test store completes with `--max-old-space-size=256`.
- **EC-3** Concurrency: a node with `concurrency: k` never has more than `k` steps in flight, and reaches `k` when work is available; `maxInFlight` caps the total across nodes.
- **EC-4** `foreach` runs one iteration per input item with the configured body concurrency, and `FrameEntered`/`FrameExited{input-done}` are emitted once per input item.
- **EC-5** `while`/`until` iterate to the condition and emit the final state; `until` always runs the body at least once, `while` may run it zero times.
- **EC-6** A `while` whose condition never becomes false ends `failed{reason:'budget'}` with a `BudgetExceeded{budget:'iterations'}` event, and does not hang.
- **EC-7** A frame exceeding `maxDurationMs` ends `failed{budget}` with `BudgetExceeded{budget:'time'}`; in-flight step signals are aborted.
- **EC-8** `retry` succeeds on attempt k after k-1 failures with the specified backoff delays; exhaustion either fails the run or emits on `error` per `onExhausted`.
- **EC-9** A failing step outside a `retry` frame fails the run with `reason:'step'` and the node id; its `StepFailed` is in the log.
- **EC-10** **Resume equivalence:** for every abort point in a randomized set (including mid-flush), resuming (seeded prefixes `events[0..k]` of an uninterrupted run with `flush.maxEvents=1`, copied into a fresh store) yields the same final `StepSucceeded` set, exactly one per `(node,itemId)`, as an uninterrupted run, and a gapless `seq`.
- **EC-11** `ctx.now()`/`ctx.random()` return identical values on re-execution after resume (asserted with a step that records them, after a resume whose prefix includes the `SideEffect` but not the `StepSucceeded`).
- **EC-12** Resuming with a non-deterministic source (items change) fails the run with `internal` and a message naming the source, rather than producing silent wrong output.
- **EC-13** Aborting `signal` produces `RunCancelled`, no events after it, and `executeRun` returns within the 5 s grace even if a step ignores its signal.
- **EC-14** A second executor appending with a stale `expectedSeq` makes the first return `fenced` and stop issuing steps.
- **EC-15** Nested frames (`foreach` containing `retry` containing `while`) execute and resume correctly.

## Open Questions

Ordered output (preserve input order through a node) is not provided; add as a node option when a flow needs it.
Per-item `Map-Reduce` and `Paginate` frames are Phase 3+.
