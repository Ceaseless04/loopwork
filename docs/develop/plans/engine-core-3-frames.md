# Plan: engine-core-3-frames

Spec (verbatim brief): `docs/develop/specs/engine-core-3-frames.md`
Source of truth (a spec wins over the brief): `SPEC-engine-core.md` (ForEach, Retry, Budgets, Streaming, EC-4/7/8), `SPEC-event-log.md` (frame events, item ids, fold edge counters and the `F.<exit>` -> `F.out` alias), `SPEC-graph-model.md` (frame nodes, ports, scoped ids, budgets); `CONSTRAINTS.md`; `docs/develop/plans/engine-core-2-skeleton.md` (decisions D1-D10, conventions - inherited unless amended below).
Branch `feat/engine-core-3-frames`, stacked on `origin/docs/engine-core-frames-design` (PR #14, spec clarifications; base `372c3d7`). Slice 3 of 6. PRs target that branch until #14 merges, then retarget `main`. A human merges.

Read-only for every task: `CONSTRAINTS.md`, `SPEC-*.md`, `CAPABILITY-MAP.md`, `docs/adr/*`, the public contracts of `@loopwork/graph` / `@loopwork/eventlog`, the SC-3 dist rule (below), thresholds and budgets. If a spec point blocks you, write a question to `.develop/inbox/questions/` (main repo) instead of editing a spec.

## Conventions

- Everything in the skeleton plan's Conventions section applies (TDD, `it('EC-n: ...')` naming, strict TS flags, `.js` suffixes, no `console`/stdout, floor-guard: never remove or retitle an `it(` line and never net-remove `expect(` lines; commit per task, message names the task id, end with the attribution trailer the environment demands).
- Environment per command: `export PATH=/root/work/loopwork-wt-phase1-foundation/.tools/bin:/root/.nvm/versions/node/v22.23.3/bin:$PATH`.
- Fresh worktree: no `node_modules`, no `dist`. First command of T1: `pnpm install --frozen-lockfile --offline` (workspace links only; if offline fails, `pnpm install --frozen-lockfile`), then `pnpm build` (writes `dist` for graph/eventlog/engine; gitignored). Repeat `pnpm build` after any change in `packages/graph` or `packages/eventlog` (none expected). Never read `node_modules` or the lockfile.
- Gate after EVERY task (green on its own commit): `pnpm --filter @loopwork/engine test`, `pnpm typecheck`, `pnpm lint`, `pnpm check:arch`, and `wc -l packages/engine/src/*.ts` (no file over 270 lines; guideline). T7 runs the whole `check:task`.
- Tests: `MemoryStore` + `createBuiltins()` + registered custom fns only. No real sleeps. Time-dependent tests use vitest fake timers (`vi.useFakeTimers()` fakes `Date` as well as timers; `afterEach(vi.useRealTimers)`). Drive time with `await vi.advanceTimersByTimeAsync(ms)` to a bound just past the last expected timer, never `runAllTimersAsync()` while a long budget timer is armed. Use `flush: { maxEvents: 1, maxMs: 1 }` only where a test must see events in the store mid-run.
- Footprint = the exact files a task may modify.
- Mutation spot-check = after the task is green, apply each listed mutation locally, confirm a named test fails, revert. No mutation tooling; do not commit mutations.

## Public APIs this slice consumes (read-only)

`@loopwork/graph`: `Flow`, `FlowNode`, `Frame` (`{kind:'frame', frame:'foreach'|'while'|'until'|'retry', body:{nodes,edges,entry,exit}, budgets:{maxIterations,maxDurationMs}, in, out}`; foreach `concurrency`; retry `maxAttempts`, `backoff:{kind:'fixed'|'exponential',baseMs}`, `onExhausted`), `Edge`, `PortRef`, `JsonValue`, `flow()` builder (`.frame(id, Frame)`; `.edge('F.error','err.in')` splits at the LAST `.`). Body `nodes`/`edges`/`entry`/`exit` use LOCAL ids (`b`), the engine builds scoped ids (`F.b`) itself exactly like `packages/eventlog/src/fold.ts` `indexScope` (prefix + id, nested prefix `F.G.`). `portsOf`/`walkScopes` are NOT exported; the engine derives ports itself (`out`, plus `error` on a frame).
`@loopwork/eventlog`: events `FrameEntered{node,itemId,frame}`, `IterationStarted{node,itemId,iteration}`, `IterationEnded{...,elapsedMs}`, `FrameExited{node,itemId,reason,outputs?}`, `BudgetExceeded{node,itemId,budget,limit,used}`, plus the step events of slice 2 (`StepFailed.willRetry` is now `true` on a retried attempt). Fold facts the engine must honour: `consumed` increments on `StepStarted` only for `attempt === 1` and on `FrameEntered`; a body exit item's producer `F.b.out` is aliased to `F.out`'s edges; `FrameExited.outputs` are counted as emissions on `F.<port>`; a `StepFailed{willRetry:true}` keeps the item in `inFlight` until the next `StepStarted`.
Item ids (brief + SPEC-event-log): foreach/retry body entry item id = instance id unchanged; body outputs `${itemId}>${F}.${b}.out#k` (node = scoped id); retry error item `${in}>${F}.error#0`; idempotency key `${runId}/${scopedNode}/${itemId}` (unchanged by attempt).

## Decisions fixed by this plan (D11 onward; D1-D10 stand except where amended)

- D11 (amends D1 import graph) Modules: `execute.ts` (run lifecycle: log read, recorder, stop, terminal event, top-level call), `scope.ts` (NEW; `createRunScope(env)` -> `runScope(opts)`: wiring, sources, step pools, frame pools, `runStep`), `frames.ts` (NEW; frame-instance lifecycle, budget timer, retry helpers; a LEAF: imports only types and `scheduler`/`recorder` types), `guards.ts` (NEW; `unrunnable`, moved verbatim in T1), `scheduler.ts`. Imports: `execute -> {scope, guards, recorder, channel, registry}`, `scope -> {frames, channel, scheduler, registry}`, `frames -> {recorder(type), registry(type)}`. `scope.ts` and `frames.ts` never import `execute.ts` (not even types: they use the positional callback `fail(reason, message, node?)`, not `RunOutcome`), so rule 10 (no cycles) holds. Deviation from the brief's wording ("`runScope` closure in execute.ts"): same semantics (shared `ctrl`/`rec`/`emit`/global limiter via an explicit `ScopeEnv`), but a module, because `execute.ts` is already 253 lines of a 270-line guideline and the frame code would roughly add 60-100 more. `Item` (`{itemId, value}`) moves to `registry.ts` (D1: shared types live there), not re-exported from `index.ts`.
- D12 `ScopeEnv` (built once in `executeRun`): `{ runId, input, registry, signal /* ctrl.signal */, rec, emit /* gated by signal.aborted */, fail(reason, message, node?) /* = stop({status:'failed',...}), first wins */, limiter /* global maxInFlight */, capacity /* channelCapacity */, channels: Set<Channel<Item>> /* every LIVE channel; stop() closes them all */ , nodeLimiters: Map<string, Limiter> }`. `stop()` iterates `env.channels` (replaces the old `channels` Map).
- D13 One `runScope` call = one wiring: LOCAL `targets`/`refs`/channel maps (keys `scopedNode.port`), channels registered in `env.channels` on creation and removed by `scope.dispose()`. Top level: prefix `''`, never disposed. A frame instance calls `runScope` for its body with prefix `${F}.`, so per-instance state is O(body size) and freed at instance end (engine memory stays O(in-flight), EC-2 spirit). Per-instance scopes are why channel keys may repeat across instances.
- D14 Body concurrency: the pool for scoped body node `sid` uses `chain(nodeLimiterOf(sid, n.concurrency ?? 1), env.limiter)` where `nodeLimiterOf` get-or-creates in `env.nodeLimiters` (run-wide, keyed by scoped id, so it is shared by every instance, including instances of a frame nested in several outer instances). `chain(first, then)` (scheduler.ts) acquires `first` then `then`, releases in reverse. ALWAYS node before global: a worker parked on a node permit must not sit on a global permit (that would starve other nodes below `maxInFlight`, breaking EC-3 inside bodies). Top-level nodes keep the plain global limiter (behaviour of slice 2). A frame node itself is not a step: its pool uses `nodeLimiterOf(frameSid, frameConcurrency)` ALONE (foreach: `concurrency`; retry: 1), never a global permit, held for the whole instance.
- D15 Entry/exit seams (added to `ScopeOpts` in T3, not before - code unreachable by tests would sink the changed-line coverage gate): `entry: string` (scoped body entry port key; `refs` gets +1 for the frame boundary BEFORE the "close unfed channels" loop, so the entry channel stays open until `enter()` releases it); `exit: { port: string; send(item: Item): Promise<void> }` (scoped body exit port key and a sender into the frame's outer `out` targets; `sendTo(producer, item)` additionally calls `exit.send` when `producer === exit.port`); `enter(item)` sends the instance item to the entry channel (abort-tolerant like `sendTo`) and then decrements the entry ref (closing the channel). The frame's own parent scope releases ITS `F.out` / `F.error` targets once, when the frame pool resolves (every exit send has completed by then because continuations are awaited by the pool).
- D16 Write-ahead per instance (frames.ts `runInstance`): `await rec.ready()` -> `FrameEntered{node:F,itemId,frame}` -> `IterationStarted{iteration}` (iteration passed in, default 1) -> arm the budget timer -> `await runBody(instance)` (enter + body pools resolve) -> if aborted return -> `IterationEnded{iteration, elapsedMs}` -> `FrameExited{reason, outputs?}` -> only then `send` the exit `outputs` downstream. foreach: reason `input-done`, no `outputs`. retry: `success`, or `retries-exhausted` (+ `outputs:[{port:'error', itemId:`${in}>${F}.error#0`, value:{message, item:<frame in value>}}]` when `onExhausted==='emit-error'`). An instance is a `Instance = {itemId, value, iteration, elapsedMs, timer?, exhausted?: {message}}` in a per-frame `instances: Map<itemId, Instance>` (set at entry, deleted in `finally`; the slice 4/5 seam, keyed like `fold.frames.active`).
- D17 Retry (scope.ts `runStep(id, n, item, attempt, retry?)`, the single source of the attempt number): `makeCtx(node, itemId, attempt, runInput?)`; `StepStarted.attempt` and `StepFailed.attempt` both read `ctx.attempt` (the hardcoded `attempt: 1` is removed). `retry` (type `RetryScope` in frames.ts: `{maxAttempts, backoff, onExhausted, exhaust(message)}`) is passed down by the nearest retry ancestor (a nested non-retry frame forwards its parent's; a nested retry overrides). On failure: if the run is already aborted return silently (an aborted step is not a failure and not a retry); `willRetry = retry !== undefined && attempt < retry.maxAttempts`; log `StepFailed{willRetry}`; retry -> return a continuation `sleep(backoffMs(...), signal)` (no permit held) then `runHeld(limiter, item => runStep(..., attempt + 1, retry), item, signal)` then run the continuation that returns; exhausted + `emit-error` -> `retry.exhaust(message)` (first wins), no `stop`, the step produces nothing and the rest of the body drains; exhausted otherwise (fail-run, or no retry ancestor) -> `fail('step', message, id)`. `backoffMs`: `fixed` -> `baseMs`; `exponential` -> `min(baseMs * 2 ** (attempt - 1), 60_000)`. Resume seam only: `runStep` takes the starting attempt as a parameter; slice 3 always passes 1 (resume is still rejected by `unrunnable`, so reading `inFlight` would be dead code; slice 5 wires `inFlight.get(itemId) + 1` and the "already > maxAttempts -> straight to exhaustion" rule).
- D18 Time budget (frames.ts): `setTimeout(onBreach, Math.max(0, maxDurationMs - instance.elapsedMs))` armed at `IterationStarted` (elapsedMs = logged, 0 in this slice), `unref`'d, cleared in `finally` (always, so a stopped run never leaves a long timer). `elapsedMs` = one helper `elapsed(t0) = Date.now() - t0` (engine clock, bookkeeping, not replayed; no new `ExecuteOptions` field; comment why this `Date.now()` is allowed per the spec's Budgets text). `onBreach`: if the instance is already done, return; `emit(BudgetExceeded{node:F,itemId,budget:'time',limit:maxDurationMs,used:instance.elapsedMs + elapsed(t0)})` then `fail('budget', message, F)` in the same synchronous tick. First-wins is the existing `emit` gate (aborted -> dropped) plus `fail` being a no-op once decided. `ctx.signal` stays the global `ctrl.signal`, so the global abort is what aborts in-flight steps (spec: "that frame's in-flight steps"; the run ends anyway).
- D19 (amends D7) `unrunnable` walks bodies recursively: allows `foreach` (T3) and `retry` (T4), keeps rejecting `while`/`until` with a message containing "frame" and "slice 4", checks `registry.has` for every body node (unknown fn names the SCOPED id), and rejects a `source` node inside a body ("source in a frame body is not supported"; the graph validator allows it but a per-instance source has no defined semantics in this slice). The existing test `a frame node fails the run as internal` (execute.test.ts) keeps its title and expectations; only its fixture frame changes from `foreach` to `while` (T3).
- D20 (amends D8) `makeCtx` call-index counters (`now#i`/`random#i`) stay per execution context, so a retried attempt restarts at `now#0` and logs fresh `SideEffect`s. The spec says indexes are "shared across attempts" and replayed; replay is slice 5. Do not change in slice 3; file a question in `.develop/inbox/questions/` noting that retry attempts re-log `now#0`.

## Acceptance-criteria coverage matrix

| ID | Tasks |
|---|---|
| EC-4 | T3 (test); T1 (scope machinery), T2 (`chain`) |
| EC-7 | T6 (test); T3 (instance lifecycle it hooks into) |
| EC-8 | T4 (success path + delays), T5 (exhaustion both modes); T2 (`backoffMs`, `sleep` units) |
| No regressions (EC-1/2/3/9/14, all existing tests) | every task gate; T1 is behaviour-preserving |
| `check:task` < 90 s; criteria map gains EC-4/7/8; README accurate | T7 |
| `while`/`until` still rejected, resume/cancel-grace out of scope | T3 (guard), enforced by `unrunnable` |

## Dependency DAG

```
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7
```

Strictly linear in practice. T2 touches only `scheduler.ts` (after T1) and `frames.ts` (new), so it could in principle run beside T3's test scaffolding, but T3 consumes `chain` and shares `frames.ts`. T6 depends only on T3 logically but shares `frames.ts` with T4/T5, so it runs after them. Each task leaves the repo working: T1 (pure refactor), T2 (new exported-but-unused helpers with unit tests), T3 (foreach runs, retry/while/until still rejected), T4 (retry runs for success path; exhaustion paths exist from T4 only as fail-run), T5 (both exhaustion modes), T6, T7.

## T1 - Behaviour-preserving refactor: scope.ts, guards.ts, runHeld, attempt plumbing, per-port release

**Covers:** no criterion; regressions guard (EC-1/2/3/9/14 untouched).
**Depends on:** none.

**Files**
- `packages/engine/src/execute.ts` (shrinks)
- `packages/engine/src/scope.ts` (new)
- `packages/engine/src/guards.ts` (new; `unrunnable` moved verbatim)
- `packages/engine/src/scheduler.ts` (`runHeld`; `runPool` uses it)
- `packages/engine/src/registry.ts` (add `export type Item = { itemId: string; value: JsonValue }`)

**Interfaces**
```ts
// scheduler.ts
/** Acquire a permit, run `handle(item)`, always release; resolves undefined without running if `signal` aborted after the acquire. */
export async function runHeld<T, R>(limiter: Limiter, handle: (item: T) => Promise<R>, item: T, signal?: AbortSignal): Promise<R | undefined>;
// guards.ts
export function unrunnable(flow: Flow | undefined, state: RunState, registry: NodeRegistry): string | undefined;   // unchanged behaviour
// scope.ts (frames/entry/exit/retry options arrive in T3-T5, NOT here)
export type ScopeEnv = { runId: string; input: JsonValue | undefined; registry: NodeRegistry; signal: AbortSignal; rec: Recorder;
  emit(e: NewEvent): void; fail(reason: 'step' | 'budget' | 'internal', message: string, node?: string): void;
  limiter: Limiter; capacity: number; channels: Set<Channel<Item>> };
export type ScopeOpts = { nodes: Record<string, FlowNode>; edges: Edge[]; prefix: string };
export type Scope = { work: Promise<void>[]; dispose(): void };
export function createRunScope(env: ScopeEnv): (o: ScopeOpts) => Scope;
```
`nodeLimiters` is added to `ScopeEnv` in T3 (first use).

**What moves where (read `execute.ts` as of `372c3d7`; line refs are approximate)**
- Stays in `executeRun`: reading the log (63-67), `ctrl`, `decided`, `stop`, `rec`, `emit`, `finish` (69-99), `RunStarted` + flush + fence check (101-103), the `unrunnable` call (104-106), the `onAbort` wiring and the final `Promise.all(work.map(catch -> stop internal))` + `finish` (238-252). Build `env`, then `const { work } = createRunScope(env)({ nodes: flow.nodes, edges: flow.edges, prefix: '' })`. `stop` now closes `env.channels` (a `Set`, replacing the `channels` Map at line 70/77).
- Moves to `scope.ts` inside `createRunScope`: wiring (108-137: `capacity`, `targets`, `refs`, channel creation, the "close unfed" loop, `release`, `sendTo`), `fnOf` and `makeCtx` (139-162), `limiter` is now `env.limiter`, and the per-kind loop (165-236: source task, map/sink pool).
- Local to each `runScope` call: `targets`, `refs`, `channels` (a local `Map<string, Channel<Item>>`; each created channel is also added to `env.channels`). `scope.dispose()` deletes this scope's channels from `env.channels`. Keys are `prefix + id + '.' + port`: iterate `Object.entries(nodes)` with `sid = prefix + id` and edges mapped `${prefix}${e.from.node}.${port}`. Event `node` fields, `makeCtx(node, ...)` and item-id suffixes all use `sid` (identical to today with prefix `''`).
- `release(producer)` generalises to releasing every output port: after a source/pool resolves call `release(`${sid}.out`)` and `release(`${sid}.error`)` (`error` has no `targets` entry for non-frame nodes, so it is a no-op; it matters from T5).
- `makeCtx(node, itemId, attempt, runInput?)` replaces the hardcoded `attempt: 1`; `StepStarted.attempt` and `StepFailed.attempt` both read `ctx.attempt`. Introduce `runStep(item, attempt)` as the pool `handle` body (call it with `1`); its catch block and continuation shape stay exactly as today (the retry branch is T4).
- `runPool`'s worker body (acquire / aborted-check / handle / release) becomes `next = await runHeld(limiter, handle, r.value, stop.signal)`. Keep the exact current semantics: acquire is not abortable; after acquire, if the signal is aborted return without running `handle`; the permit is released in `finally`. `runPool` tests stay unchanged.

**Steps**
- [ ] Install + build (Conventions), then run the baseline `pnpm --filter @loopwork/engine test` and record the pass count and `wc -l` of `execute.ts` in the commit message.
- [ ] No new `it` is required (pure refactor; the existing suite is the safety net, and `runHeld` is exercised through every `runPool` test). Do NOT add the entry/exit/retry options yet (unreachable code lowers changed-line coverage on the 3a PR).
- [ ] Move `unrunnable` to `guards.ts` verbatim (still rejects every frame node with today's message). Add `Item` to `registry.ts`.
- [ ] Implement `runHeld` in `scheduler.ts`; switch `runPool` to it.
- [ ] Create `scope.ts` per the split above; slim `execute.ts`. Keep `index.ts` untouched (export set unchanged).
- [ ] Gate (Conventions). `execute.ts` should land near 120 lines, `scope.ts` near 150.
- [ ] Mutation spot-check: (a) in `runHeld` skip the `release` on the handler-throws path -> `scheduler.test.ts` / `execute-failure.test.ts` fail or hang; (b) pass `attempt: 2` to the first `runStep` -> `execute-failure.test.ts` EC-9 (`attempt: 1`) fails; (c) forget `env.channels.add` -> abort/cancel tests in `execute-failure.test.ts` hang or fail.
- [ ] Commit `T1: ...` (this is the 3a boundary, see PR stack).

**Pitfalls**
- Behaviour must be byte-identical: same event order (write-ahead `ItemEmitted` before sends, `StepSucceeded` before sends, sink `rec.flush()` before `StepSucceeded`), same stop/abort handling, same `rec.ready()` placement.
- Do not let `scope.ts` import `./execute.js` for `RunOutcome` (cycle); use the positional `fail`.
- The `sendTo` try/catch (closed channel is expected after stop) must be kept as is.

## T2 - Primitives: `chain` limiter, `backoffMs`, abortable `sleep`

**Covers:** supports EC-4 (body concurrency ordering), EC-8 (delays).
**Depends on:** T1.

**Files**
- `packages/engine/src/scheduler.ts` (add `chain`)
- `packages/engine/src/frames.ts` (new; `backoffMs`, `sleep`)
- `packages/engine/test/scheduler.test.ts` (one new `it`)
- `packages/engine/test/frames-retry.test.ts` (new; one `it` for now, T4/T5 add the criterion tests)

**Interfaces**
```ts
// scheduler.ts
/** acquire `first` then `then`; release in reverse. `inFlight` reports `then`'s (the global cap's). */
export function chain(first: Limiter, then: Limiter): Limiter;
// frames.ts
export type Backoff = { kind: 'fixed' | 'exponential'; baseMs: number };
export function backoffMs(b: Backoff, attempt: number): number;   // fixed: baseMs; exponential: min(baseMs * 2 ** (attempt - 1), 60_000)
export function sleep(ms: number, signal: AbortSignal): Promise<void>;
```
`sleep`: a Promise around the GLOBAL `setTimeout` (never `node:timers/promises`: vitest fake timers do not patch it); rejects with `signal.reason` on abort and on an already-aborted signal; clears the timer and removes the abort listener on both paths.

**Steps**
- [ ] Tests first (RED, `import` fails until implemented): `scheduler: chain takes the first limiter before the second and releases in reverse` - global `g = createLimiter(1)` held by someone else, `n = createLimiter(2)`: `chain(n, g).acquire()` stays pending while `n.inFlight === 1` (node acquired first); releasing `g` resolves it; `release()` frees both. `frames: backoffMs and sleep` - fixed returns `baseMs` for any attempt; exponential 1000 -> 1000, 2000, 4000 and `backoffMs({exponential, 1000}, 20) === 60_000`; `sleep(500, signal)` pending until `vi.advanceTimersByTimeAsync(500)` under fake timers, rejects on abort (listener removed, `vi.getTimerCount() === 0`).
- [ ] Implement.
- [ ] Gate.
- [ ] Mutation spot-check: swap `chain`'s acquire order -> the chain test fails; drop the `2 **` exponent offset (`attempt` instead of `attempt - 1`) or the `60_000` cap -> the backoff test fails; `sleep` not clearing its timer on abort -> the `getTimerCount` assertion fails.
- [ ] Commit `T2: ...`.

## T3 - foreach frames end to end (EC-4)

**Covers:** EC-4.
**Depends on:** T2.

**Files**
- `packages/engine/src/scope.ts` (frame branch; entry/exit/`dispose`; `nodeLimiters`; body limiters)
- `packages/engine/src/frames.ts` (`Instance`, `FrameHost`, `runInstance`)
- `packages/engine/src/execute.ts` (only to create `env.nodeLimiters`)
- `packages/engine/src/guards.ts` (recursion; allow `foreach`)
- `packages/engine/test/helpers.ts` (frame flow builders)
- `packages/engine/test/frames-foreach.test.ts` (new)
- `packages/engine/test/execute.test.ts` (guard fixture frame `foreach` -> `while`; title and `expect` lines unchanged)

**Interfaces**
```ts
// frames.ts
export type Instance = { itemId: string; value: JsonValue; iteration: number; elapsedMs: number; timer?: ReturnType<typeof setTimeout>; exhausted?: { message: string } };
export type FrameHost = { rec: Recorder; emit(e: NewEvent): void; signal: AbortSignal;
  fail(reason: 'step' | 'budget' | 'internal', message: string, node?: string): void;
  send(port: 'out' | 'error', item: Item): Promise<void> };      // into the frame's outer targets (abort-tolerant)
export async function runInstance(h: FrameHost, f: { id: string; node: Extract<FlowNode, { kind: 'frame' }>; instances: Map<string, Instance> },
  item: Item, runBody: (inst: Instance) => Promise<void>, iteration?: number /* default 1 */): Promise<void>;
// scope.ts: ScopeEnv gains nodeLimiters: Map<string, Limiter>; ScopeOpts gains entry?, exit?, (retry? in T4); Scope gains enter(item): Promise<void>
```
`runInstance` implements D16 for foreach (retry reasons are added in T4/T5, the budget timer in T6; leave their seams as small clearly-named code, not TODO text).

**Frame pool in `runScope` (per `kind === 'frame'` node, `fsid = prefix + id`)**
- Input channel is `channels.get(`${fsid}.in`)` (already created: frames are non-source nodes). Concurrency: foreach -> `n.concurrency`.
- `work.push(runPool({ input, concurrency, limiter: nodeLimiterOf(fsid, concurrency), signal: env.signal, handle: (item) => runInstance(host, { id: fsid, node: n, instances }, item, runBody) }).then(() => releaseOutputs(fsid)))`. `handle` returns no continuation: the whole instance runs while the frame-limiter permit is held (no global permit).
- `runBody(inst)`: `const sub = runScope({ nodes: n.body.nodes, edges: n.body.edges, prefix: `${fsid}.`, entry: `${fsid}.${n.body.entry.node}.${n.body.entry.port}`, exit: { port: `${fsid}.${n.body.exit.node}.${n.body.exit.port}`, send: (it) => sendTo(`${fsid}.out`, it) } })`; `try { await sub.enter({ itemId: inst.itemId, value: inst.value }); await Promise.all(sub.work); } finally { sub.dispose(); }`. If `env.signal.aborted` skip entering at all.
- Body node pools (`prefix !== ''`): `limiter: chain(nodeLimiterOf(sid, n.concurrency ?? 1), env.limiter)` (D14).

**Steps**
- [ ] Add to `helpers.ts`: `frameFlow(frame: Frame, o?: { count?: number; sink?: string; errorSink?: boolean }): Flow` -> `src(range) -> F -> snk` (and `F.error -> err` when `errorSink`), plus `foreachFrame({ body nodes record, concurrency, maxDurationMs? })` building a one-node body (`b`: entry `b.in`, exit `b.out`) with `budgets { maxIterations: 1, maxDurationMs: 600_000 }`, `in: {}`, `out: {}`. Keep builders tiny (no duplicated linearFlow logic).
- [ ] Tests first (RED): in `frames-foreach.test.ts`:
  - `EC-4: foreach runs one iteration per input item with the configured body concurrency and one FrameEntered/FrameExited per item` - `range 6 -> foreach F (concurrency 3, body b = registered gate map with node concurrency 2, controllable deferreds) -> discard`. Assert: 6 `FrameEntered` and 6 `FrameExited{input-done}` with distinct item ids `src.out#0..5` and no `outputs`; per-instance order `FrameEntered < IterationStarted{1} < StepStarted(F.b) < StepSucceeded(F.b) < IterationEnded < FrameExited`; peak concurrent `F.b` handlers === 2 (shared limiter, and reached); sink `snk` receives 6 items with ids `${in}>F.b.out#0` (proves item ids and the exit forwarding to `F.out`); `foldRun` status `succeeded`, gapless `seq`, edge counters `F.out->snk.in` emitted === consumed === 6 (fold alias), and `state.frames.get('F')` has no active instance and `exitedCount === 6`.
  - `frames: bodies are validated recursively: while/until stay unrunnable, unknown fn in a body names the scoped node, a source in a body is rejected` - three tiny flows (`internal` failures; messages: `/frame/i` + `slice 4`, `/"F\.b".*nope/`, `/source/`), plus one assertion that a foreach body of a built-in map runs (covered by EC-4 itself).
- [ ] Update the existing guard test's fixture (`frame: 'while'` with a `condition`), keep title and both `expect`s.
- [ ] Implement `guards.ts` recursion (walk bodies with the scoped id; allow `frame === 'foreach'`, reject `retry`, `while`, `until` for now with a "slice" message), the scope/frames code above, and `env.nodeLimiters` in `executeRun`.
- [ ] Gate. Also a one-off, NOT committed, memory sanity check using the black-box child pattern of `stream-heap.timed.test.ts` (run the built engine with `node --max-old-space-size=256`, a foreach(identity) over 20k items via a hand-copied child script in the scratchpad): heap must stay flat, confirming `dispose()` and `instances` cleanup. Add a committed foreach heap test only if it costs under ~3 s (check:task budget).
- [ ] Mutation spot-check: remove `sub.dispose()` -> the one-off memory check grows (and `env.channels` leaks); give body pools `env.limiter` only (drop the node limiter) -> the EC-4 peak assertion (2) fails; swap `chain` order in the body pool -> EC-3 style assertions under `maxInFlight` stay green, so rely on T2's unit test for this one; move the `IterationEnded` emit after `FrameExited` -> the per-instance order assertion fails; skip `enter`'s entry release -> the run hangs (test timeout).
- [ ] Commit `T3: ...`.

**Pitfalls**
- The entry channel's `refs` +1 must happen before the unfed-channels-close loop, or the body entry channel is closed on creation and the instance item is lost.
- `sendTo` for the exit key must include `exit.send`; nested frames compose because each scope forwards its own exit key (a frame that is its parent's exit forwards through the parent's `exit.send`).
- Do not hold a global permit while waiting on the body: the frame pool uses only the frame limiter.
- After `stop`, a new instance may still start: `runInstance` and `runBody` must check `signal.aborted` first (runPool already returns early for an aborted pool signal); a body scope created post-stop would otherwise leave open channels.
- Fold alias: do not synthesise entry/exit edges anywhere; item ids carry lineage.

## T4 - retry success path (EC-8a)

**Covers:** EC-8 (success on attempt k with the specified backoff delays).
**Depends on:** T3.

**Files**
- `packages/engine/src/scope.ts` (`runStep` retry branch, `retry` option inherited by nested frames)
- `packages/engine/src/frames.ts` (`RetryScope`, retry instance wiring: concurrency 1, reason `success`)
- `packages/engine/src/guards.ts` (allow `retry`)
- `packages/engine/test/helpers.ts` (`retryFrame(...)` builder)
- `packages/engine/test/frames-retry.test.ts`

**Interfaces**
```ts
// frames.ts
export type RetryScope = { maxAttempts: number; backoff: Backoff; onExhausted: 'fail-run' | 'emit-error'; exhaust(message: string): void };
// scope.ts: ScopeOpts gains retry?: RetryScope
```
`runStep(id, n, item, attempt, retry?)` per D17: abort check first; `willRetry`; log `StepFailed{willRetry}`; the continuation sleeps with NO permit, then `runHeld(chain-limiter, ...)` re-acquires node + global permits and runs `runStep(attempt + 1)`; `exhausted` branches arrive in T5 (until then an exhausted step takes the `fail('step', ...)` path).

**Steps**
- [ ] Tests first (RED): `EC-8: retry succeeds on attempt k after k-1 failures with the specified backoff delays and re-runs only the failed step` - `range 1 -> retry R (maxAttempts 4, exponential baseMs 1000, fail-run) -> discard`, body `a -> b` (two registered maps; `b` fails while `ctx.attempt < 3`, recording attempts; `a` counts calls), fake timers, `vi.spyOn(globalThis, 'setTimeout')` to collect delays, use `budgets.maxDurationMs: 3_600_000` and `flush` defaults. Drive with `await vi.advanceTimersByTimeAsync(3000)`. Assert: delays containing `[1000, 2000]` in order (filter the spy to values >= 1000 and < 3_600_000); ctx attempts seen by `b` `[1,2,3]`; log: `StepStarted(R.b)` attempts 1,2,3; `StepFailed(R.b)` attempts 1,2 with `willRetry:true` (the third attempt succeeds); `StepSucceeded(R.a)` count 1 (committed steps are not re-run) and `a` called once; `IterationStarted{1}`/`IterationEnded` once, `FrameExited{success}`; run `succeeded`; `foldRun` consumed count for `R.b` unchanged by retries (edge `R.a.out->R.b.in` consumed === emitted === 1).
- [ ] Implement.
- [ ] Gate.
- [ ] Mutation spot-check: `attempt < maxAttempts` -> `<=` (an extra attempt/`willRetry` flip; fails the StepFailed/attempt assertions); drop the `Math.min(..., 60_000)` cap (T2 unit already fails); hard-code `attempt: 1` back into `StepStarted` (attempt assertions fail); run the backoff sleep inside `handle` while holding the permit (assert nothing here; mention in the PR that the permit-free wait is by construction: `sleep` lives in the continuation).
- [ ] Commit `T4: ...`.

**Pitfalls**
- Post-stop continuations: a backoff continuation that outlives `stop` must log nothing and start no step: `sleep` rejects on abort (swallow only when `signal.aborted`, rethrow otherwise) and `runHeld(..., signal)` skips the handler if aborted after the acquire.
- First-wins: StepFailed for an aborted step must not be logged (abort check precedes the catch classification).
- `retry` inherited through non-retry frames only; a nested retry overrides.
- The retry frame processes one instance at a time (`concurrency` 1); do not use the global limiter for the instance.

## T5 - retry exhaustion (EC-8b)

**Covers:** EC-8 (exhaustion: `fail-run` and `emit-error`).
**Depends on:** T4.

**Files**
- `packages/engine/src/scope.ts` (exhaust branch; `error` port releases; `F.error` sender)
- `packages/engine/src/frames.ts` (`exhausted` marker, `retries-exhausted` exit, error item)
- `packages/engine/test/frames-retry.test.ts`

**Steps**
- [ ] Tests first (RED), two `it`:
  - `EC-8: retry exhaustion with fail-run fails the run with reason step` - body map always throws, `maxAttempts 2`, fixed `baseMs 1000`: log has `StepFailed{attempt:1, willRetry:true}` then `StepFailed{attempt:2, willRetry:false}`, outcome `failed{reason:'step', node:'R.b'}`, terminal `RunFailed` last, NO `FrameExited` for the instance.
  - `EC-8: retry exhaustion with emit-error logs FrameExited retries-exhausted with an error item, sends it on error and lets the other body branches finish` - `range 1 -> retry R (emit-error) -> {out -> snk, error -> errSink(collecting)}`, body with two parallel branches (one always fails, one succeeds and exits through `out`; `entry` feeds both): assert `FrameExited{reason:'retries-exhausted', outputs:[{port:'error', itemId:'src.out#0>R.error#0', value:{message, item:<in value>}}]}` is logged BEFORE the error sink's `StepStarted`; the surviving branch's output still reaches `snk` (outputs already sent stand); the run `succeeded`; fold: no active instance, edge `R.error->err.in` emitted === 1 === consumed (counted from `FrameExited.outputs`); the run does not hang (both sinks' channels closed: this exercises `release(R.error)`).
- [ ] Implement: exhausted + `emit-error` -> `retry.exhaust(message)` (first wins), no `stop`; `runInstance` reads `inst.exhausted` after the body drains; send via `host.send('error', ...)` after `FrameExited`. In the frame pool, `releaseOutputs(fsid)` already releases `out` and `error` (T1 loop); verify.
- [ ] Gate.
- [ ] Mutation spot-check: release only `${sid}.out` (not `.error`) -> the emit-error test hangs on the error sink (timeout); emit `FrameExited` after sending the error item (write-ahead order) -> the order assertion fails; abort the siblings on exhaustion (`fail(...)`) -> the surviving-branch / `succeeded` assertions fail.
- [ ] Commit `T5: ...`.

**Pitfalls**
- Do not abort siblings on emit-error exhaustion (their `StepStarted` would be left without a result in the log: orphaned `inFlight` entries that resume would re-run). Note for slice 5: the exhausted step itself ends with `StepFailed{willRetry:false}` (fold removes it from `inFlight`) and has no `StepSucceeded`; resume must key off `FrameExited`, not committed steps.
- The error item's `item` is the frame's `in` value (`inst.value`), not the failing step's input.

## T6 - time budget (EC-7)

**Covers:** EC-7.
**Depends on:** T5 (shares `frames.ts`; logically T3).

**Files**
- `packages/engine/src/frames.ts` (budget timer, `elapsed` helper, `BudgetExceeded`, `finally` cleanup)
- `packages/engine/test/frames-budget.test.ts` (new)

**Steps**
- [ ] Tests first (RED): `EC-7: a frame exceeding maxDurationMs ends failed budget with BudgetExceeded time and aborts in-flight step signals` - fake timers; `range 1 -> foreach F (maxDurationMs 5000, body b = registered map that records ctx.signal and awaits its abort, ignoring time) -> discard`. Advance `vi.advanceTimersByTimeAsync(5000)`. Assert: outcome `{status:'failed', reason:'budget', node:'F'}`; log order `... IterationStarted, BudgetExceeded{node:'F', itemId:'src.out#0', budget:'time', limit:5000, used:5000}`, then terminal `RunFailed{reason:'budget', node:'F'}` last; NO `IterationEnded`/`FrameExited`/`StepFailed` after the breach; the captured step `signal.aborted === true`; `foldRun` marks the instance `breached`; `vi.getTimerCount()` shows no leftover budget timer after `executeRun` resolves (drop this last assertion if the recorder legitimately leaves a timer; do not weaken the others).
- [ ] Implement D18. Arm after `IterationStarted`, clear in `finally`.
- [ ] Gate.
- [ ] Mutation spot-check: arm the timer with `maxDurationMs` regardless of `elapsedMs` (no-op today, covered by the `max(0, ...)` expression: change `-` to `+` -> `used`/timing assertions fail); log `BudgetExceeded` after calling `fail` (dropped by the emit gate -> event missing -> fails); do not clear the timer on normal exit -> run T3's foreach test with a spy asserting no timers, or the `getTimerCount` assertion fails.
- [ ] Commit `T6: ...`.

**Pitfalls**
- Emit `BudgetExceeded` BEFORE `fail`, in one synchronous tick; `fail` sets `decided` and aborts, after which `emit` drops everything (that gate is the first-wins mechanism; no extra flag).
- Instance wall time includes backoff and exit backpressure by construction (the timer spans the whole `runBody`).
- A budget timer must never keep a finished or stopped process alive: `unref` + `finally`-clear.

## T7 - criteria map, README, final verification

**Covers:** "criteria map gains EC-4, EC-7, EC-8", "README stays accurate", the no-regression and 90 s budget criteria.
**Depends on:** T6.

**Files**
- `scripts/criteria-map.mjs` (append `'EC-4'`, `'EC-7'`, `'EC-8'` to `EXPECTED_IDS`; update the comment: remaining EC ids land in slices 4-6)
- `scripts/test/criteria-map.test.ts` (the `expects SC-1..7, ...` test body: length 39 -> 42 and the id list; keep the `it` title)
- `README.md` (the engine sentence: now runs `foreach` and `retry` frames and the time budget; `while`/`until`, resume, Postgres still later)
- `packages/engine/src/*` only if a test exposes a bug

**Steps**
- [ ] Update the three files. `node scripts/criteria-map.mjs` must list EC-4, EC-7, EC-8 mapped to the new test files and exit 0, with the earlier 39 ids still mapped.
- [ ] Final checks (Node 22 first on PATH, from the worktree root, after `pnpm build`): `pnpm --filter @loopwork/engine test`, `pnpm check:arch`, `node scripts/criteria-map.mjs`, `LOOPWORK_BASE_REF=$(git rev-parse origin/docs/engine-core-frames-design) bash -c 'time pnpm check:task'`. `check:task` must stay under 90 s (baseline ~70 s at slice 2; the new tests are 8 `it`, all on `MemoryStore` with fake timers and at most a few items, so the expected add is a few seconds). Record the measured time in the commit message and the PR description. Re-check `wc -l packages/engine/src/*.ts` (all <= 270).
- [ ] Commit `T7: ...`.

## PR stack cut (recommended)

- **3a = T1 only** (PR base `docs/engine-core-frames-design`; retarget to `main` once #14 merges). One commit `T1: ...`, a pure refactor reviewable as "no behaviour change": `execute.ts` shrinks, `scope.ts`/`guards.ts` appear, `runHeld` added, `attempt` plumbing. Verified by the whole existing suite; no criterion; no criteria-map change. Its changed-line coverage is high because nothing new is unreachable (entry/exit/retry options are deliberately NOT added here).
- **3b = T2-T7** (PR base `feat/engine-core-3-frames` 3a branch; retarget to its parent as parents merge): frames + retry + budget + criteria map. Commit boundaries: one commit per task. If the 3b diff looks too big for review, cut it again after T3 (3b = T2+T3 foreach/EC-4, 3c = T4-T7 retry/budget/EC-7/EC-8/criteria map); the clean boundary is "after T3 green": `foreach` is complete there and retry/while/until are still rejected by `unrunnable`. Criteria-map and README stay in the last PR so `EXPECTED_IDS` and its test change once.
- Each PR's `check:task` runs with `LOOPWORK_BASE_REF` = its own base sha.

## Risks and notes

- **270-line guideline.** `execute.ts` is 253 lines now; D11's split (guards.ts, scope.ts, frames.ts) is what keeps every file under it. If `scope.ts` approaches 270 after T5, extract `runStep`/`makeCtx`/`fnOf` into `steps.ts` (imports: registry, scheduler, frames; no cycle) rather than compacting code.
- **Import cycles (rule 10).** `frames.ts` is a leaf and receives callbacks (`runBody`, `FrameHost.send`, `fail`); `scope.ts` imports `frames.ts`, never the reverse; neither imports `execute.ts` (not even types). `pnpm check:arch` after every task.
- **SC-3 dist rule.** depcruise never follows `dist/` and resolves `@loopwork/*` to `src/index.ts`; tests resolve workspace packages through `dist` at runtime (needs `pnpm build`; CI's `task` job already builds first). New tests import engine code from `../src/...` and workspace packages by name; NO static import of `dist` anywhere. Only a black-box child test (like `stream-heap.timed.test.ts`: runtime-built URL to `packages/engine/dist/index.js`, `--max-old-space-size=256`, `cwd` = the engine package, result via a temp file, throw if `dist` is missing) may touch `dist`. The foreach memory check in T3 is a one-off, not committed unless it is cheap.
- **90 s `check:task`.** Currently ~70 s. Keep new tests to ~8 `it` (T2: 2, T3: 2, T4: 1, T5: 2, T6: 1), items counts of 1-6, deferreds instead of sleeps, fake timers for backoff/budget, and no 100k-style loops. Measure at T7; if over, shrink counts before touching any threshold.
- **Fake timers and the recorder.** The recorder arms a `maxMs` timer; `executeRun` flushes explicitly at `RunStarted` and the terminal, so a run needs only the frame's own timers advanced. Filter `setTimeout` spies by delay (>= 1000) so recorder timers (default 50 ms) do not pollute delay assertions. Vitest fakes `Date`, so `elapsedMs`/`used` are exact.
- **`ctx.now()`/`random()` across attempts (D20)**: indexes restart per attempt in this slice; raise a question for slice 5 rather than changing behaviour here.
- **Source in a body (D19)**: rejected as unrunnable; the graph validator permits it. Confirm with the architect via a question if a flow needs it.
- **Nested frames** (EC-15) are not an acceptance criterion of this slice, but `runScope` recursion and inherited `retry`/exit forwarding are written to compose; only `while`/`until` nesting is rejected. No test beyond what T3-T5 need.
- **Resume is rejected** (`unrunnable` still refuses logs with work), so `Instance.elapsedMs` is always 0 and `runStep` always starts at attempt 1 in this slice; the seams are parameters, not dead code reading `inFlight`.
- **Test-volume policy** (stacked PRs, proportionate; see project memory): about 8 `it` cases for the slice, mutation spot-checks only, no property tests, no hostile-input matrices.

## Out of scope for this bundle

`while`/`until` frames and `BudgetExceeded{iterations}` (slice 4), resume/replay and `resume.ts` (slice 5), `cancelGraceMs` and pg-backed tests (slice 6), `maxCostUsd`/`maxTokens`, any change to specs, `CONSTRAINTS.md`, graph/eventlog public contracts, `index.ts` exports, thresholds or CI budgets.
