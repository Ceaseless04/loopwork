# Plan: engine-core-2-skeleton

Spec (verbatim brief): `docs/develop/specs/engine-core-2-skeleton.md`
Source of truth (a spec wins over the brief): `SPEC-engine-core.md` (Project Structure, Contract, Semantics, EC-1/2/3/9/14), `SPEC-event-log.md` (Events, item ids, foldRun), `SPEC-graph-model.md`; `CONSTRAINTS.md` (architecture rules 1-10, floors); `CAPABILITY-MAP.md` repo-wide conventions.
Branch `feat/engine-core-2-skeleton`, cut from `6acd3ce` (`origin/main`). Slice 2 of 6 of the stacked engine-core PRs; PR targets `main`, human merges.

Read-only for every task: `CONSTRAINTS.md`, `SPEC-*.md`, `CAPABILITY-MAP.md`, `docs/adr/*`, Postgres migrations, the public contracts of `@loopwork/graph` and `@loopwork/eventlog`. If a spec point blocks you, write a question to `.develop/inbox/questions/` (main repo) instead of editing a spec.

## Conventions

- TDD, proportionate: focused tests per criterion, no hostile-input matrices. Criterion tests are named `it('EC-1: <what it proves>', ...)` (the `EC-n:` prefix is what `node scripts/criteria-map.mjs` matches). Non-criterion unit tests use a plain prefix (`channel:`, `recorder:`, ...).
- ESM, strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `.js` import suffixes, `import type` for types, named exports, no `any`, no suppression comments (`noInlineConfig`), no `console.*`, no `process.stdout` anywhere under `packages/**` (eslint `no-restricted-properties`).
- floor-guard: do not remove or retitle an existing `it(` line anywhere. The one existing test whose BODY changes (`scripts/test/criteria-map.test.ts`, T9) keeps its title, or the commit carries a non-empty `Test-Change-Reason:` trailer line.
- Footprint = the exact files a task may modify. Every task leaves `pnpm --filter @loopwork/engine test`, `pnpm typecheck` and `pnpm lint` green on its own commit. Commit per task, message names the task id, end with the attribution trailer the environment demands.
- Engine code never reads the wall clock or `Math.random` on a path a logged step outcome depends on, except through `ctx.now()` / `ctx.random()` (logged as `SideEffect`). Recorder / backoff timers use `setTimeout` (fake-timer friendly).
- Environment per command: `export PATH=/root/work/loopwork-wt-phase1-foundation/.tools/bin:/root/.nvm/versions/node/v22.23.3/bin:$PATH`.

## Public APIs this slice consumes (read-only)

`@loopwork/eventlog` (`packages/eventlog/src/index.ts`; runtime imports resolve to `dist`, see risks):
- `EventStore` (interface): `create(runId, RunCreated)`, `append(runId, NewEvent[], { expectedSeq }): Promise<{ lastSeq }>`, `read(runId, { fromSeq?, limit? }): AsyncIterable<LoopworkEvent>`, `subscribe`, `getRun`, `listRuns`.
- `SeqConflictError` (class; `code 'E_SEQ_CONFLICT'`, `name 'SeqConflictError'`) thrown by `append` when `expectedSeq !== lastSeq`. Also `RunClosedError` (append after terminal; after a `failed` only a `RunStarted` with a higher `attempt` is allowed), `UnknownRunError`, `InvalidEventError`.
- Types `NewEvent` / `LoopworkEvent` (= `NewEvent & { runId, seq, ts }`), `RunStatus`, `RunRow`. Event members the engine appends in this slice: `RunStarted{workerId, attempt}`, `ItemEmitted{node, itemId, value}`, `SourceCompleted{node, count}`, `StepStarted{node, itemId, attempt}`, `StepSucceeded{node, itemId, outputs:{port,itemId,value}[]}`, `StepFailed{node, itemId, attempt, error:{name,message,stack?}, willRetry}`, `SideEffect{node, itemId, key, value}`, `RunSucceeded`, `RunFailed{reason, message, node?}`, `RunCancelled{requestedBy?}`. (Frame events and `BudgetExceeded` are slices 3-4.)
- `emptyRunState()`, `applyEvent(state, event)`, `RunState` (`flow?`, `lastSeq`, `attempt`, `status`, `nodes`, `edges`, `frames`, `committed`, `sourcesCompleted`, `sideEffects`, ...). `foldRun` takes a SYNC `Iterable`, but `store.read` is an `AsyncIterable`, so `executeRun` loops `for await` with `applyEvent(emptyRunState(), e)`.
- `MemoryStore` (tests only): `new MemoryStore({ now?, pollMs? })`; keeps every event.
- `RunState` has NO run input; `executeRun` captures `input` from the `RunCreated` event while reading the log (the first event).

`@loopwork/graph` (`packages/graph/src/index.ts`):
- Types `Flow` (`{version:1,id,name,nodes,edges}`), `FlowNode` (`source {fn, params?, out}`, `map {fn, params?, in, out, concurrency?}`, `sink {fn, params?, in, concurrency?}`, `frame`), `Edge`/`PortRef` (`{node, port}`; ports: source `out`, map `in`/`out`, sink `in`), `JsonValue`.
- `edgeId(edge)` = `${from.node}.${from.port}->${to.node}.${to.port}`; `scopedId(...parts)` joins with `.`; `flow(id, name)` builder (`.source/.map/.sink/.frame/.edge('a.out','b.in')/.build()`), used by tests.
- NOT exported: `walkScopes` / any topological helper. The engine builds its own adjacency (`Map<'node.port', Edge[]>`) from `flow.nodes` + `flow.edges`; no graph contract change. Plain-flow slice: any `kind: 'frame'` node makes the run fail `internal` ("frames land in slices 3-4").
- Item ids (SPEC-event-log): source items `${node}.out#${index}`; step outputs `${inputItemId}>${node}.${port}#${k}` (array output of a map = fan-out on `out`, `k` = array index; non-array = `#0`).

## Decisions fixed by this plan (so tasks need no further context)

- D1 Types live in `registry.ts` (`StepContext`, `SourceFn`, `MapFn`, `SinkFn`, `PredicateFn`, `NodeKind`, `NodeRegistry`) and `execute.ts` (`ExecuteOptions`, `RunOutcome`), exactly the Contract in the spec. No `types.ts` (file list in the brief), no import cycles (rule 10): `execute -> {registry, channel, scheduler, recorder}`, `builtins -> registry`, `scheduler -> channel`, `recorder -> eventlog`.
- D2 One channel per node input port; every producer sends a copy of each output to the channel of every edge target (fan-out over edges). The channel closes when its last feeding producer finished (producer refcount kept by `execute.ts`, not by the channel).
- D3 `ItemEmitted` is write-ahead: pushed BEFORE the item is sent to its channel(s) (log first, then deliver; once per source item even with several targets; same for map outputs, whose `StepSucceeded` is pushed before the sends), so a crash never leaves a delivered item the log does not know about; still gated by the internal stop signal (no push after stop) and the send still awaits backpressure; `StepStarted` is recorded when a worker holds the item AND has the global in-flight permit. The permit covers only the step's `fn`: `handle` returns an optional continuation (the backpressured sends, the `StepSucceeded` push and the sink's recorder flush) that `runPool` runs after releasing the permit. Hence on an edge fed by the SOURCE, for a consumer with concurrency k, the logged emitted-minus-consumed gap is at most `channelCapacity + k + 1` (the +1 is the write-ahead item parked on a full channel); EC-2 is amended accordingly (architect decision). On map-fed edges a fan-out logs all N outputs before sending, so no such bound is claimed there.
- D4 "Flush before a sink reports success": `await rec.flush()` after the sink `fn` resolves and before `StepSucceeded` is pushed; terminal event: push terminal, then `rec.close()` (which flushes).
- D5 Failure: the first failing plain step pushes `StepFailed{attempt, error, willRetry:false}`, then run stops with outcome `failed{reason:'step', node, message}`. Aborted steps (run aborted by failure/cancel/fence) log nothing; completions after the outcome is decided are dropped; after the terminal event the recorder is closed.
- D6 Fence: recorder sees `SeqConflictError` -> drops its buffer, calls `onFenced`, becomes inert (no more appends, no terminal event). `executeRun` aborts all work and returns `{status:'fenced'}`. The first append (`RunStarted`) uses `opts.expectedSeq`; later appends chain on the returned `lastSeq`.
- D7 `executeRun` guards (each a few lines, one tiny test in T6/T7, not a criterion): unknown `fn` in the registry (`registry.has`) -> `failed{internal}` naming node and fn; `frame` node -> `failed{internal}`; a log that already holds work events (`state.committed.size > 0`, any `sourcesCompleted`, any edge `emitted > 0`, any `inFlight`) -> `failed{internal, 'resume lands in engine-core slice 5'}`; log already `succeeded`/`cancelled` -> return that status without appending. The internal failures append `RunStarted` then `RunFailed`.
- D8 `ctx.now()` / `ctx.random()`: pass-through (`Date.now()` / `Math.random()`) plus `SideEffect{key: 'now#i' | 'random#i'}` (`i` = per `(node,itemId)` call index, map entry deleted when the step ends so memory stays O(in-flight)). Replay is slice 5.
- D9 Minimal cancellation (T7): `opts.signal` abort -> stop scheduling, abort step signals, wait for workers to settle, flush, push `RunCancelled`, flush, return `cancelled`. KNOWN GAP until slice 6: a step that ignores its signal blocks the return; `cancelGraceMs` is accepted in the options type but unused (note in code with a `ponytail:` comment).
- D10 Test import of workspace packages is by package name (resolves to `dist`). No vitest alias is added; deps must be built first (`pnpm build` / `pnpm typecheck`, which `check:task` runs before tests). The 100k test (T8) is an `*.timed.test.ts` run in a worker thread with `resourceLimits.maxOldGenerationSizeMb: 256`, N = 100k kept in the unit test (`bench:stream` lands in slice 6) - see T8 spike for the fallback.

## Acceptance-criteria coverage matrix

Criteria (brief bullets, in order): EC-1, EC-2, EC-3, EC-9, EC-14, AC-pkg (package builds/typechecks/lints, depcruise rules pass, `criteria-map` maps the five ids and keeps the existing 34, `check:task` < 90 s).

| ID | Tasks |
|---|---|
| EC-1 | T6 (test); T4 (built-ins it relies on), T2/T3/T5 (machinery) |
| EC-2 | T8 (test: gap bound, 100k heap-limited run); T2 (channel backpressure unit test) |
| EC-3 | T5 (pool + global cap test); T8 (executeRun-level check) |
| EC-9 | T7 |
| EC-14 | T9 (test); T3 (recorder fencing unit); T6/T7 (wiring) |
| AC-pkg | T1 (scaffold, lockfile, depcruise check), T9 (criteria-map ids, README, final `check:task` + timing) |

## Dependency DAG

```
T1 -> T2 -> T5 -+
T1 -> T3 -------+
T1 -> T4 -------+-> T6 -> T7 -> T8 -> T9
```

T2, T3, T4 touch disjoint files and may run in parallel after T1; T5 needs T2 (channel). T6 needs T2-T5. T7, T8, T9 are strictly sequential (they share `execute.ts` / test helpers and a test may reveal a source fix).

## T1 - Package scaffold, workspace linking, tooling check

**Covers:** AC-pkg (package builds/typechecks/lints, depcruise passes).
**Depends on:** none.

**Files**
- `packages/engine/package.json` (new)
- `packages/engine/tsconfig.json` (new)
- `packages/engine/src/index.ts` (new, placeholder `export {};`, replaced in T6)
- `pnpm-lock.yaml` (importer entry for `packages/engine`, via pnpm; do not hand-edit)

**Interfaces**
- `package.json`: mirror `packages/eventlog/package.json` - `name: "@loopwork/engine"`, `version "0.0.0"`, `private`, `type: module`, `exports["."] = { types: "./dist/index.d.ts", default: "./dist/index.js" }`, scripts `build: "tsc -b"`, `typecheck: "tsc -b"`, `test: "vitest run --root ../.. --project unit --passWithNoTests packages/engine/"` (the exact string `scripts/test/sc-1-workspace.test.ts` pins), `dependencies: { "@loopwork/eventlog": "workspace:*", "@loopwork/graph": "workspace:*" }`. No `bench:stream` (slice 6), no `pg`.
- `tsconfig.json`: as eventlog: extends `../../tsconfig.base.json`, `rootDir src`, `outDir dist`, `tsBuildInfoFile dist/tsconfig.tsbuildinfo`, `types: ["node"]` (engine uses `node:fs`, `node:readline`), `references: [{path:"../graph"},{path:"../eventlog"}]`.

**Steps**
- [ ] Create the three files above.
- [ ] `pnpm install --offline` (workspace linking only, no new third-party deps; if offline fails use `pnpm install --lockfile-only` then `pnpm install`) so `packages/engine/node_modules/@loopwork/{graph,eventlog}` link and `pnpm-lock.yaml` gains the importer. `git diff pnpm-lock.yaml` must show only the `packages/engine` importer block.
- [ ] `pnpm build` (produces `dist` of graph + eventlog + engine; dist is gitignored), `pnpm typecheck`, `pnpm lint`.
- [ ] `pnpm check:arch` passes: the existing `rule-04-engine-layering` already covers `packages/engine` (no depcruise config edit expected; `.dependency-cruiser.cjs` is only touched if the check shows otherwise). `scripts/test/sc-1-workspace.test.ts` (runs inside `pnpm test`) auto-checks the package script shape.
- [ ] Record a baseline `time pnpm check:task` duration (with `LOOPWORK_BASE_REF=$(git rev-parse origin/main)`) in the commit message body; T9 compares against it for the 90 s budget.
- [ ] Commit `T1: ...`.

## T2 - Bounded async channel

**Covers:** EC-2 (backpressure primitive).
**Depends on:** T1.

**Files**
- `packages/engine/src/channel.ts` (new)
- `packages/engine/test/channel.test.ts` (new)

**Interfaces**
```ts
export type RecvResult<T> = { done: false; value: T } | { done: true };
export interface Channel<T> {
  readonly capacity: number;
  readonly size: number;                                  // buffered items
  send(value: T, signal?: AbortSignal): Promise<void>;    // resolves once the item is buffered or handed to a waiting receiver; waits while size === capacity
  recv(signal?: AbortSignal): Promise<RecvResult<T>>;     // waits while empty; {done:true} once closed AND drained
  close(): void;                                          // idempotent; wakes receivers; pending/later send rejects with ChannelClosedError
}
export class ChannelClosedError extends Error {}
export function createChannel<T>(capacity: number): Channel<T>;
```
`capacity` must be an integer >= 1 (throw `RangeError` otherwise). An aborted `signal` rejects the pending `send`/`recv` with the signal's reason and removes the waiter.

**Steps**
- [ ] Tests first (`it('channel: ...')`, small): (a) `send` resolves immediately until `capacity` items are buffered, the next `send` stays pending until a `recv` frees a slot, and `size` never exceeds `capacity`; (b) FIFO order, `recv` on empty waits and is satisfied by a later `send`; (c) `close()` lets buffered items drain, then `recv` returns `{done:true}`; a `send` after/while closed rejects `ChannelClosedError`; (d) aborting the `signal` of a pending `send` and a pending `recv` rejects them and leaves no waiter behind (a later send/recv still works).
- [ ] Implement with an array/deque buffer plus two waiter queues (senders blocked on full, receivers blocked on empty). Keep it ~60 lines; no async iterator, no multi-producer refcount (D2: owned by `execute.ts`).
- [ ] Run `pnpm --filter @loopwork/engine test`, `pnpm typecheck`, `pnpm lint`. Commit `T2: ...`.

## T3 - Batching event recorder with fencing

**Covers:** EC-14 (recorder half), supports EC-1.
**Depends on:** T1 (parallel with T2, T4, T5).

**Files**
- `packages/engine/src/recorder.ts` (new)
- `packages/engine/test/recorder.test.ts` (new)

**Interfaces**
```ts
import type { EventStore, NewEvent } from '@loopwork/eventlog';
export interface Recorder {
  push(e: NewEvent): void;       // buffers; triggers a flush when maxEvents reached; (re)arms the maxMs timer; ignored once closed or fenced
  flush(): Promise<void>;        // resolves when everything pushed before the call is appended (or dropped because fenced); rejects with the store error on any non-conflict failure
  close(): Promise<void>;        // flush, then ignore later pushes
  readonly fenced: boolean;
  readonly lastSeq: number;      // last seq returned by the store
}
export function createRecorder(o: {
  store: EventStore; runId: string; expectedSeq: number;
  maxEvents: number; maxMs: number;
  onFenced: () => void;          // called exactly once, on the first SeqConflictError
}): Recorder;
```

**Steps**
- [ ] Tests first (`it('recorder: ...')`, vitest fake timers for `maxMs`; use `MemoryStore` with a created run for realism or a tiny stub store): (a) pushes below `maxEvents` are not appended until `maxMs` elapses; reaching `maxEvents` appends one batch immediately; (b) successive batches pass `expectedSeq` = previous `lastSeq` (gapless seq in the store); (c) explicit `flush()` appends the pending buffer in order and concurrent flushes are serialized (never two `append`s in flight); (d) a `SeqConflictError` sets `fenced`, calls `onFenced` once, drops the buffer, later `push`/`flush` do nothing; a different store error makes `flush()` reject with it and does not call `onFenced`; (e) after `close()` pushes are ignored.
- [ ] Implement: `buffer: NewEvent[]`, a single promise chain for appends, `lastSeq` initialised from `expectedSeq`, `append(runId, batch, { expectedSeq: lastSeq })`, timer via `setTimeout` (unref'd so it never keeps the process alive; cleared when the buffer empties). `instanceof SeqConflictError` is the fencing test (runtime import from `@loopwork/eventlog`).
- [ ] Run tests, `pnpm typecheck`, `pnpm lint`. Commit `T3: ...`.

## T4 - NodeRegistry and in-memory built-ins

**Covers:** EC-1 (built-ins used by every engine test).
**Depends on:** T1 (parallel with T2, T3, T5).

**Files**
- `packages/engine/src/registry.ts` (new)
- `packages/engine/src/builtins.ts` (new)
- `packages/engine/test/registry.test.ts` (new)
- `packages/engine/test/builtins.test.ts` (new)

**Interfaces**
```ts
// registry.ts (types exactly as the Contract; JsonValue from @loopwork/graph)
export type NodeKind = 'source' | 'map' | 'sink' | 'predicate';
export type StepContext = { runId: string; node: string; itemId: string; attempt: number; signal: AbortSignal;
  idempotencyKey: string; input: JsonValue | undefined; now(): number; random(): number };
export type PredicateContext = { runId: string; node: string; itemId: string; signal: AbortSignal };
export type SourceFn = (ctx: StepContext, params: JsonValue | undefined) => AsyncIterable<JsonValue>;
export type MapFn = (item: JsonValue, ctx: StepContext, params: JsonValue | undefined) => Promise<JsonValue | JsonValue[]>;
export type SinkFn = (item: JsonValue, ctx: StepContext, params: JsonValue | undefined) => Promise<void>;
export type PredicateFn = (state: JsonValue, ctx: PredicateContext, params: JsonValue | undefined) => Promise<boolean>;
export interface NodeRegistry {
  source(name: string, fn: SourceFn): void; map(name: string, fn: MapFn): void;
  sink(name: string, fn: SinkFn): void; predicate(name: string, fn: PredicateFn): void;
  has(kind: NodeKind, name: string): boolean; names(kind: NodeKind): string[];
  get(kind: 'source', name: string): SourceFn | undefined; /* + overloads for map / sink / predicate */
}
export function createRegistry(): NodeRegistry;           // duplicate name for the same kind throws
// builtins.ts
export function createBuiltins(opts?: { writeLine?: (line: string) => void }): NodeRegistry;  // writeLine defaults to a no-op
```
(`get` is an addition beyond the Contract needed by `execute.ts`; the Contract members stay exactly as specified.)

Built-in semantics (params validated minimally: wrong type throws `TypeError` naming the param):
- `source: range{count, start=0}` emits `start .. start+count-1`; `fromInput` yields the elements of `ctx.input` (must be an array); `fromFile{path}` streams NDJSON with `node:fs` + `node:readline` (one `JSON.parse` per non-empty line; never loads the whole file).
- `map: identity`; `sleep{ms}` (`setTimeout`, rejects on `ctx.signal` abort, returns the item); `tag{key,value}` (object item: `{...item,[key]:value}`; non-object: `{ value: item, [key]: value }`); `failEvery{n,message}` fails (throws `Error(message)`) when `(i + 1) % n === 0` where `i` is the FIRST `#<digits>` index found in `ctx.itemId` (the source item index; deterministic under any concurrency/resume); `increment{by=1}` (item must be a number).
- `sink: discard` (no-op); `logLine` calls `writeLine(JSON.stringify(item))` (no stdout ever; the default writer does nothing).
- `predicate: lessThan{path,value}` (dotted `path` into the state, numeric `<`), `truthy{path}`.
- NOT `pgIdempotent` (slice 6) - `registry.has('sink','pgIdempotent')` is false.

**Steps**
- [ ] Tests first: registry (`register/has/names/get`, duplicate throws, kinds are separate namespaces); builtins (each built-in in 1-2 lines of assertion: `range` count/start, `fromInput` on an array and non-array error, `fromFile` against a temp NDJSON file from `node:os` tmpdir with a trailing blank line, `sleep` aborts, `tag`, `failEvery` throws exactly for indexes 2 and 5 with `n=3` and passes others, `increment`, `logLine` calls the injected writer and the default writer writes nothing, `lessThan`/`truthy` on a nested path, `names('map')` lists exactly the five, `pgIdempotent` absent).
- [ ] Implement `registry.ts` (two `Map`s per kind is enough) and `builtins.ts` (`createBuiltins` = `createRegistry()` + registrations).
- [ ] Run tests, `pnpm typecheck`, `pnpm lint` (the lint must not flag stdout). Commit `T4: ...`.

## T5 - Scheduler: per-node worker pool and global in-flight cap

**Covers:** EC-3.
**Depends on:** T2 (channel), T1 (parallel with T3, T4).

**Files**
- `packages/engine/src/scheduler.ts` (new)
- `packages/engine/test/scheduler.test.ts` (new)

**Interfaces**
```ts
import type { Channel } from './channel.js';
export interface Limiter { acquire(): Promise<void>; release(): void; readonly inFlight: number }
export function createLimiter(max: number): Limiter;      // FIFO waiters; max >= 1
export function runPool<T>(o: {
  input: Channel<T>;                 // consumed until {done:true}
  concurrency: number;               // number of worker loops, >= 1
  limiter: Limiter;                  // global maxInFlight cap, shared by all pools
  handle: (item: T) => Promise<void | (() => Promise<void>)>; // called with the permit held (covers fn only); MUST NOT throw for step failures (execute.ts records those); may return a continuation run after the permit is released
  signal: AbortSignal;               // aborting stops taking new items
}): Promise<void>;                   // resolves when input is closed+drained and all handlers returned; rejects with the first handler/continuation error once sibling workers have settled
```
Worker loop: `recv` -> `limiter.acquire()` -> `handle(item)` -> `limiter.release()` (in `finally`, as soon as `handle` settles) -> `await continuation?.()` before taking the next item. The permit is acquired AFTER the item is received, so per node at most `concurrency` items are held outside the channel (D3).

**Steps**
- [ ] Tests first: (a) `EC-3: a node with concurrency k never has more than k handlers in flight and reaches k when work is available` (feed 3k items, each `handle` awaits a controllable deferred, track current/peak; peak === k); (b) `EC-3: maxInFlight caps the total across pools` (two pools, concurrency 3 each, `createLimiter(4)`: peak total === 4, never 5); (c) `scheduler: abort stops taking new items and a handler error rejects the pool` (small).
- [ ] Implement `createLimiter` (counter + waiter queue) and `runPool` (`concurrency` async loops, `Promise.all`).
- [ ] Run tests, `pnpm typecheck`, `pnpm lint`. Commit `T5: ...`.

## T6 - executeRun happy path (plain `source -> map* -> sink`)

**Covers:** EC-1.
**Depends on:** T2, T3, T4, T5.

**Files**
- `packages/engine/src/execute.ts` (new)
- `packages/engine/src/index.ts` (replace placeholder with the public exports)
- `packages/engine/test/helpers.ts` (new: shared test helpers, no `.test` suffix so vitest/criteria-map ignore it)
- `packages/engine/test/execute.test.ts` (new)

**Interfaces**
```ts
// execute.ts
export type ExecuteOptions = { runId: string; store: EventStore; registry: NodeRegistry; signal: AbortSignal;
  workerId: string; expectedSeq: number; cancelGraceMs?: number; channelCapacity?: number /* 64 */;
  maxInFlight?: number /* 64 */; flush?: { maxEvents: number; maxMs: number } /* {500, 50} */ };
export type RunOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; reason: 'step' | 'budget' | 'internal'; message: string; node?: string }
  | { status: 'cancelled' } | { status: 'fenced' };
export function executeRun(opts: ExecuteOptions): Promise<RunOutcome>;
// index.ts public exports
export type { NodeRegistry, StepContext, PredicateContext, SourceFn, MapFn, SinkFn, PredicateFn, NodeKind } from './registry.js';
export { createRegistry } from './registry.js';
export { createBuiltins } from './builtins.js';
export type { ExecuteOptions, RunOutcome } from './execute.js';
export { executeRun } from './execute.js';
// helpers.ts (tests only)
export function pipelineFlow(o: { mapFn?: string; mapParams?: JsonValue; mapConcurrency?: number; sinkFn?: string; sinkConcurrency?: number; count: number }): Flow; // uses graph's flow() builder: src(range) -> m -> snk
export async function startRun(store: MemoryStore, runId: string, flow: Flow, input?: JsonValue): Promise<{ expectedSeq: number }>; // store.create(...), expectedSeq = 1
export async function eventsOf(store: EventStore, runId: string): Promise<LoopworkEvent[]>;
```
Not exported from `index.ts` (internal): channel, scheduler, recorder.

Algorithm (`execute.ts`):
1. Read the log: `for await (const e of store.read(runId))` -> `applyEvent`; remember `input` from the `RunCreated` event. Apply guards D7 (before any scheduling).
2. Create the recorder (`createRecorder`, `onFenced -> stop({status:'fenced'})`), an internal `AbortController` linked to `opts.signal`, and a first-outcome-wins `stop(outcome)` (aborts the internal controller, closes all channels so blocked workers wake).
3. `rec.push(RunStarted{workerId, attempt: state.attempt + 1})`, `await rec.flush()` (a fence here returns `fenced`).
4. Build adjacency from `flow.edges`; one channel per node (`channelCapacity`), producer refcount per channel; for each source node: iterate `fn(ctx, params)`, for each value push `ItemEmitted{node, itemId: `${node}.out#${i}`, value}` (write-ahead, D3), THEN `send` to the target channels of every `source.out` edge; at the end push `SourceCompleted{node, count}` and decrement the refcount of its target channels (closing at 0). Sources are not subject to `maxInFlight`.
5. For each map/sink node: `runPool({ input, concurrency: node.concurrency ?? 1, limiter, handle })`. `handle` (map): push `StepStarted{attempt:1}`, call `fn(item, ctx, params)` (the permit covers only this), normalise the result to an array only when it is an array (fan-out), and return a continuation that pushes `StepSucceeded{outputs:[{port:'out', itemId: `${itemId}>${node}.out#${k}`, value}]}`, then sends each output to the target channels (run by `runPool` after the permit is released). `handle` (sink): `StepStarted`, `fn`, and return a continuation that does `await rec.flush()` (D4) then pushes `StepSucceeded{outputs: []}`. `StepContext`: `idempotencyKey = `${runId}/${node}/${itemId}``, `attempt: 1`, `signal` = internal signal, `input` set for sources only, `now()`/`random()` per D8.
6. When all sources, pools finished and the run was not stopped: push `RunSucceeded`, `await rec.close()`, return `{status:'succeeded'}`. Unexpected throws map to `failed{internal, message}` (append `RunFailed{reason:'internal'}` unless fenced).

**Steps**
- [ ] `helpers.ts` + tests first (`execute.test.ts`, MemoryStore, built-ins via `createBuiltins()`, no timers): (a) `EC-1: source -> map -> sink over N items commits N steps per node and the run succeeds` - N = 25 with `range -> increment -> discard`; assert outcome `succeeded`, `StepSucceeded` count === N for `m` and for `snk`, `ItemEmitted` count === N, `SourceCompleted{count:N}`, `RunStarted{attempt:1, workerId}` first after `RunCreated`, `RunSucceeded` last, `foldRun` status `succeeded`, seq gapless; (b) `execute: array output fans out on out with #k item ids` (a registered map returning `[v, v]`: 2N sink steps, ids `${in}>m.out#0/#1`); (c) `execute: ctx exposes idempotencyKey and logs now/random as SideEffect` (registered map reads `ctx.idempotencyKey`, calls `now()` twice and `random()` once: keys `now#0`, `now#1`, `random#0` present); (d) `execute: guards` - unknown fn name -> `failed internal` naming it; a flow containing a frame node -> `failed internal`; a log that already has a committed step -> `failed internal` mentioning resume; a second `executeRun` on a succeeded run returns `succeeded` and appends nothing. Keep (d) to 4 short assertions.
- [ ] Implement `execute.ts` per the algorithm (small helper functions inside the file; items are `{ itemId: string; value: JsonValue }`), write `index.ts`.
- [ ] Run `pnpm --filter @loopwork/engine test`, `pnpm typecheck`, `pnpm lint`, `pnpm check:arch`. Commit `T6: ...`.

## T7 - Failure path (EC-9) and minimal cancellation

**Covers:** EC-9.
**Depends on:** T6.

**Files**
- `packages/engine/src/execute.ts`
- `packages/engine/test/execute-failure.test.ts` (new)

**Interfaces**
- No signature changes. `execute.ts` gains: step error classification (a rejected `fn` outside any frame fails the run), D5 completion-dropping once `stop()` decided, and minimal cancellation D9.

**Steps**
- [ ] Tests first (`execute-failure.test.ts`): (a) `EC-9: a failing plain step fails the run with reason step and the node id, its StepFailed is in the log` - `range 10 -> failEvery{n:5, message:'boom'} -> discard`; outcome `{status:'failed', reason:'step', node:'m', message:'boom'}`; log contains a `StepFailed{node:'m', willRetry:false, error.message:'boom'}` and a terminal `RunFailed{reason:'step', node:'m'}` as the LAST event; `foldRun(...).status === 'failed'`; no `StepSucceeded` for the failing item; (b) `execute: a step that fails while siblings run stops the run and logs nothing after RunFailed` (concurrency 3, no event after the terminal one, steps aborted by the run signal log nothing); (c) `execute: aborting opts.signal appends RunCancelled and returns cancelled` (map blocks on `ctx.signal`; abort; last event `RunCancelled`; no events after it; no `StepFailed` for the aborted step).
- [ ] Implement: in `handle`, `catch` -> if the internal signal is already aborted drop silently, else push `StepFailed{attempt, error:{name,message,stack}, willRetry:false}` and `stop({status:'failed', reason:'step', message, node})`. Final path in `executeRun`: wait for pools/sources to settle (workers wake via closed channels / aborted signal), flush, then push the terminal event for the decided outcome (`RunFailed{reason,message,node?}` / `RunCancelled`), flush, close the recorder. `cancelGraceMs` accepted but unused: add a `ponytail:` comment naming the ceiling (a signal-ignoring step blocks return) and the upgrade (slice 6, EC-13).
- [ ] Run tests, `pnpm typecheck`, `pnpm lint`. Commit `T7: ...`.

## T8 - Backpressure, concurrency and discarding-store tests (EC-2, EC-3)

**Covers:** EC-2, EC-3 (executeRun level).
**Depends on:** T7.

**Files**
- `packages/engine/test/discard-store.ts` (new test helper: `EventStore` that keeps only `RunCreated`, `lastSeq` and an optional `onAppend(events)` hook; `read` yields the stored `RunCreated` only; `append` checks `expectedSeq` and throws `SeqConflictError` like `MemoryStore`; `create/subscribe/getRun/listRuns` minimal)
- `packages/engine/test/backpressure.test.ts` (new: gap bound, small N)
- `packages/engine/test/stream-heap.timed.test.ts` (new: 100k run, last-run group)
- `packages/engine/test/stream-heap.worker.mjs` (new: worker entry, only if the T8 spike picks the worker approach)
- `packages/engine/test/concurrency.test.ts` (new: executeRun-level EC-3)

**Steps**
- [ ] Spike first (time-boxed): how to enforce `--max-old-space-size=256` inside vitest. Preferred: `new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { count: 100_000 } })`; the worker (plain `.mjs`, no TS) imports `../dist/index.js` (engine) and `@loopwork/eventlog`/`@loopwork/graph` by name, defines a ~20-line inline discarding store, runs `executeRun` over `range -> identity -> discard` and posts `{ outcome, maxHeapUsedMb }`; the test fails if the worker errors with `ERR_WORKER_OUT_OF_MEMORY`. `dist` exists because `check:task` runs `typecheck` (= `tsc -b`) first; the test throws a clear "run pnpm build" error if `dist/index.js` is missing (never silently skips). Fallback if the worker cannot load the packages under vitest: run in-process against `discard-store.ts`, sample `process.memoryUsage().heapUsed` every 5000 appends via `onAppend`, assert max < 200 MB, and record in the commit message and PR description that the literal `--max-old-space-size=256` flag is exercised by `bench:stream` in slice 6. State which was chosen in the commit message.
- [ ] Tests first: (a) `EC-2: with a sink slower than the source the emitted-minus-consumed gap never exceeds channelCapacity + concurrency + 1` - `backpressure.test.ts`, DiscardStore `onAppend` hook tallies, per edge, `ItemEmitted` (source->m) and `StepStarted{attempt:1}` per node; `range 2000 -> identity (concurrency 2) -> slow sink (registered sink awaiting a few microtask ticks / `setImmediate`, concurrency 1)`, `channelCapacity: 4`; assert max gap on `src.out->m.in` <= 4 + 2 and on `m.out->snk.in` <= 4 + 1, and that the run succeeded; (b) `EC-2: a 100k-item run against a discarding store completes under 256 MB old space` - `stream-heap.timed.test.ts` (N = 100_000, chosen for the unit test; `bench:stream` is slice 6); asserts outcome `succeeded` and the worker did not run out of memory; keep default `channelCapacity`/`flush`; (c) `EC-3: executeRun honors node concurrency and maxInFlight` - `concurrency.test.ts`, a registered map probing current/peak in-flight (deferred release), `mapConcurrency: 3` -> peak 3; with `maxInFlight: 2` -> peak 2.
- [ ] Fix whatever the tests expose in `scheduler.ts`/`channel.ts`/`execute.ts` (footprint extends to those files only for fixes; keep the change minimal). The engine must not retain per-item state (no per-item maps/sets beyond in-flight; the D8 call-index map entry is deleted when a step ends).
- [ ] Time the new tests (`pnpm --filter @loopwork/engine test`); the 100k test should be a few seconds. If it threatens the 90 s `check:task` budget, reduce N in the unit test, keep 100k for `bench:stream` (slice 6), and state the chosen N in the commit message and PR description (brief allows this).
- [ ] Run `pnpm typecheck`, `pnpm lint`. Commit `T8: ...`.

## T9 - Fencing test (EC-14), criteria map, README, final verification

**Covers:** EC-14, AC-pkg.
**Depends on:** T8.

**Files**
- `packages/engine/test/fencing.test.ts` (new)
- `scripts/criteria-map.mjs` (append the five ids to `EXPECTED_IDS`)
- `scripts/test/criteria-map.test.ts` (the `expects SC-1..7, ...` test body: length 34 -> 39 and a `toContain('EC-14')`; keep the title so floor-guard's retitle rule is not tripped, otherwise add a `Test-Change-Reason:` commit trailer)
- `README.md` (one sentence: `packages/engine` = `@loopwork/engine`, the in-process executor over graph + eventlog; no behaviour docs)
- `packages/engine/src/{execute,recorder}.ts` (only if the test exposes a bug)

**Interfaces**
- `criteria-map.mjs`: `EXPECTED_IDS = [...range('SC', 7), ...range('GM', 9), ...range('WL', 8), ...range('EL', 10), 'EC-1', 'EC-2', 'EC-3', 'EC-9', 'EC-14']` (a literal list because the rest of EC-4..EC-15 land in slices 3-6; each slice appends its own ids). Add a one-line comment saying so.

**Steps**
- [ ] Test first (`fencing.test.ts`, MemoryStore, `flush: { maxEvents: 1, maxMs: 1 }` so events reach the store immediately): `EC-14: a second executor appending with the current seq fences the first, which returns fenced and stops issuing steps` - `range 100 -> m (concurrency 1, map fn blocks on a deferred and honors ctx.signal) -> discard`; once the first `StepStarted` is in the store, the test plays the second executor: `store.append(runId, [{type:'SideEffect', ...}], { expectedSeq: <current lastSeq> })`; then release the deferred; assert `executeRun` resolves `{status:'fenced'}`, no `StepStarted`/terminal event follows the second executor's event in the log (compare the log after fenced with the log snapshot right after the intruder's append), the map fn call count stopped growing, and the log has no `RunSucceeded`/`RunFailed`/`RunCancelled`. Add a second short assertion/test: `executeRun` called with a stale `expectedSeq` (e.g. 0) returns `fenced` immediately having appended nothing.
- [ ] Fix any exposed bug in `execute.ts`/`recorder.ts` (minimal).
- [ ] Update `criteria-map.mjs`, its test, and README as listed. `node scripts/criteria-map.mjs` must print EC-1, EC-2, EC-3, EC-9, EC-14 mapped to named test files and exit 0, with the previous 34 ids still mapped.
- [ ] Final checks from the worktree root (Node 22 first on PATH): `pnpm --filter @loopwork/engine test`, `pnpm check:arch`, `node scripts/criteria-map.mjs`, `LOOPWORK_BASE_REF=$(git rev-parse origin/main) pnpm check:task` (typecheck, lint, gitleaks, floor-guard, tests with coverage incl. changed-line >= 80%, depcruise). Compare `time pnpm check:task` with the T1 baseline; total must stay under 90 s.
- [ ] Commit `T9: ...`.

## Risks and notes

- **90 s `check:task` budget.** Engine adds ~10 test files; keep them synchronous-ish (no real sleeps over a few ms, fake timers for the recorder). The 100k worker test is the one heavy item (est. 3-10 s under coverage); it lives in `*.timed.test.ts` so `TimedLastSequencer` starts it last. Baseline is measured in T1, re-measured in T9.
- **No stdout from `packages/*`** (CONSTRAINTS, eslint `no-console` + `no-restricted-properties`). `logLine` takes an injectable writer, default no-op; tests of `logLine` inject an array push. Worker `.mjs` under `packages/engine/test/` is also linted by the `packages/**` block: no `console`/`process.stdout` there either (use `parentPort.postMessage`).
- **Architecture:** engine may import `@loopwork/graph` and `@loopwork/eventlog` only. `rule-04-engine-layering` already exists in `.dependency-cruiser.cjs`; rule 10 forbids runtime cycles inside the engine (keep the import graph in D1). Third-party node_modules edges are excluded by depcruise, so "engine -> graph, eventlog only" is enforced for `@loopwork/*` by rule 4 plus review; engine adds no third-party dependency.
- **ESM / exports:** `.js` import suffixes; `exports["."]` points to `dist`, so cross-package runtime imports (`SeqConflictError`, `applyEvent`, `MemoryStore`, graph `flow()`) need `pnpm build` (or `pnpm typecheck`) before `pnpm --filter @loopwork/engine test` on a fresh worktree. `depcruise` ignores `exports` and resolves to `src/index.ts`, so it is unaffected. `exactOptionalPropertyTypes`: optional props written as `x?: T | undefined` where `undefined` is passed explicitly.
- **Lockfile:** adding the workspace package changes `pnpm-lock.yaml` (CI uses `--frozen-lockfile`); commit it in T1. `minimumReleaseAge` / `trustPolicy` irrelevant (workspace deps only).
- **`RunState` has no run input** and `foldRun` is sync-only: see the API list; both handled in `execute.ts` step 1.
- **Resume / frames / budgets / grace / pg are out of scope** (slices 3-6); guards D7 make the engine fail loudly instead of corrupting a log it cannot resume. D9's known gap (signal-ignoring step blocks cancellation) is documented in code, closed by EC-13 in slice 6.
- **Flush semantic ambiguity** ("always flush before a sink reports success"): resolved literally as D4 (flush pending events before pushing the sink's `StepSucceeded`); commit durability of the sink's own `StepSucceeded` follows the normal batch flush and the terminal flush.
- **Test-volume policy** (stacked PRs, proportionate): about 30 focused `it` cases total across T2-T9; no property tests, no hostile inputs.

## Out of scope for this bundle

Frames (foreach/while/until/retry), resume and replay (`resume.ts`), `cancelGraceMs` enforcement, budgets, `pgIdempotent`, `bench:stream`, `.pg.test.ts`, spec edits, any change to graph/eventlog public contracts or Postgres schema.
