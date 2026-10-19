# Spec: event-log (`@loopwork/eventlog`)

Depends on: `graph-model`, types only (`import type { Flow, JsonValue } from '@loopwork/graph'`; no runtime import, so the package stays loadable in the browser). Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The append-only event log (ADR 0002): canonical event types, the `EventStore` interface, an in-memory and a
Postgres implementation, migrations, and `foldRun`, the pure function that turns a log into run state. This is
the single source of truth for run progress and the only thing front doors share.

## Tech Stack

TypeScript, `pg` (Postgres 16). Plain SQL migrations, no ORM.

## Commands

```
pnpm --filter @loopwork/eventlog test            # in-memory + fold
pnpm --filter @loopwork/eventlog test:pg         # Postgres store
```

`test:pg` needs `LOOPWORK_TEST_DATABASE_URL` (the pg test helper throws, it never skips, when it is unset); the repo's `docker-compose.test.yml` provides the database (see README).

## Project Structure

```
packages/eventlog/
  src/index.ts           public exports (list below)
  src/events.ts          LoopworkEvent union, NewEvent, RunStatus, RunRow, EVENT_TYPES
  src/store.ts           EventStore interface and the error classes
  src/status.ts          nextStatus, assertAppendAllowed (shared by both stores)
  src/memory-store.ts
  src/pg-store.ts
  src/migrate.ts         migrate(pool): applies migrations/*.sql in order
  src/fold.ts            foldRun, emptyRunState, applyEvent, statusOf, sideEffectKey
  migrations/001_init.sql
  test/
```

Public entry (`src/index.ts`) exports: the types `LoopworkEvent`, `NewEvent`, `RunRow`, `RunStatus`, `EventStore`, `RunState`;
the values `EVENT_TYPES`, `MemoryStore`, `PgStore`, `migrate`, `applyEvent`, `emptyRunState`, `foldRun`, `sideEffectKey`,
`statusOf`, `assertAppendAllowed`, `nextStatus`; and the error classes `SeqConflictError` (`E_SEQ_CONFLICT`),
`RunClosedError` (`E_RUN_CLOSED`), `RunExistsError` (`E_RUN_EXISTS`), `UnknownRunError` (`E_RUN_NOT_FOUND`),
`InvalidEventError` (`E_BAD_EVENT`), `SchemaTooNewError` (`E_SCHEMA_NEWER`), `MigrationConflictError`
(`E_MIGRATION_CONFLICT`).

## Events

Every stored event is `{ runId, seq, ts, type, ...payload }`. `seq` is per run, starts at 1, gapless. `node` is
always a **scoped node id** (`frame.inner.node`, see `SPEC-graph-model.md`). `itemId` is deterministic:
source items `${node}.out#${index}`; step outputs `${inputItemId}>${node}.${port}#${k}`. Replaying a step
therefore reproduces identical ids. A `while`/`until` iteration n's body entry item is `${instanceItemId}>${frame}.iter#${n}` (ids stay constant-length across iterations).

```ts
type NewEvent =
  | { type: 'RunCreated';      flow: Flow; input?: JsonValue; createdBy: 'cli'|'mcp'|'ui'|'api' }
  | { type: 'RunStarted';      workerId: string; attempt: number }                  // each (re)take of the run
  | { type: 'RunSucceeded' }
  | { type: 'RunFailed';       reason: 'step'|'budget'|'crash-loop'|'internal'; message: string; node?: string }
  | { type: 'RunCancelled';    requestedBy?: string }
  | { type: 'ItemEmitted';     node: string; itemId: string; value: JsonValue }     // source output
  | { type: 'SourceCompleted'; node: string; count: number }
  | { type: 'StepStarted';     node: string; itemId: string; attempt: number }
  | { type: 'StepSucceeded';   node: string; itemId: string; outputs: { port: string; itemId: string; value: JsonValue }[] }
  | { type: 'StepFailed';      node: string; itemId: string; attempt: number; error: { name: string; message: string; stack?: string }; willRetry: boolean }
  | { type: 'SideEffect';      node: string; itemId: string; key: string; value: JsonValue }   // 'now' | 'random' | caller keys
  | { type: 'FrameEntered';    node: string; itemId: string; frame: 'foreach'|'while'|'until'|'retry' }
  | { type: 'IterationStarted';node: string; itemId: string; iteration: number }
  | { type: 'IterationEnded';  node: string; itemId: string; iteration: number; elapsedMs: number }
  | { type: 'FrameExited';     node: string; itemId: string; reason: 'input-done'|'condition'|'success'|'retries-exhausted';
                               outputs?: { port: string; itemId: string; value: JsonValue }[] }   // while/until final state; retry emit-error
  | { type: 'BudgetExceeded';  node: string; itemId: string; budget: 'iterations'|'time'; limit: number; used: number };
type LoopworkEvent = NewEvent & { runId: string; seq: number; ts: string /* ISO-8601 */ };
```

Events are **additive-only**: new types and optional fields may be added; existing fields never change meaning.

## EventStore

```ts
interface EventStore {
  create(runId: string, first: Extract<NewEvent, {type:'RunCreated'}>): Promise<void>;       // seq 1; fails if runId exists
  append(runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }>;
  read(runId: string, opts?: { fromSeq?: number; limit?: number }): AsyncIterable<LoopworkEvent>;  // ascending
  subscribe(runId: string, opts: { fromSeq: number; signal: AbortSignal }): AsyncIterable<LoopworkEvent>; // history then live tail
  getRun(runId: string): Promise<RunRow | undefined>;
  listRuns(f: { status?: RunStatus; limit?: number; before?: string }): Promise<RunRow[]>;       // newest first
}
type RunStatus = 'queued'|'running'|'succeeded'|'failed'|'cancelled';
type RunRow = { runId: string; flowId: string; flowName: string; status: RunStatus; createdAt: string; updatedAt: string; lastSeq: number };
class SeqConflictError extends Error { code = 'E_SEQ_CONFLICT'; }
```

- `append` is one transaction. `expectedSeq` must equal the run's current `lastSeq`, else `SeqConflictError`. **This is the fence**: a zombie worker whose lease was taken over fails its next append and must stop.
- Appending may include a terminal event (`RunSucceeded|RunFailed|RunCancelled`); after one, further appends are rejected (`E_RUN_CLOSED`, also for the rest of the same batch) **except** a `RunStarted` with a higher attempt when the status is `failed` (explicit resume, see `SPEC-run-service.md`). "Higher" is strictly higher than the highest `RunStarted.attempt` already in the log (`lastAttempt`, 0 if none); the same attempt on a failed run is rejected. `lastAttempt` is not stored on the `runs` row: `MemoryStore` scans its events, `PgStore` computes `coalesce(max((payload->>'attempt')::int), 0)` over the run's `RunStarted` events inside the append transaction, after locking the `runs` row.
- `RunStarted.attempt` must be an integer in `1..2147483647` (the Postgres `int` range), else `InvalidEventError` (`E_BAD_EVENT`). `InvalidEventError` is also raised for an unknown event type, for appending a `RunCreated` to an existing run; `foldRun` / `applyEvent` throw it for a log whose first event is not `RunCreated`.
- The Postgres store maintains a `runs` projection row **in the same transaction** as the append (status from the latest terminal/started event, `last_seq`, `updated_at`). It requires UUID run ids: a non-UUID id is `InvalidEventError` on `create`, `UnknownRunError` (`E_RUN_NOT_FOUND`) on `append`, `undefined` from `getRun` and an empty `read`. `create` on an existing id throws `RunExistsError` (`E_RUN_EXISTS`); `append` on a missing run throws `UnknownRunError`.
- `read`: ascending. `fromSeq` is inclusive and defaults to 1 (values below 1 are clamped to 1); `limit` caps the number of events and `limit: 0` yields none (a negative `limit` is unspecified). `PgStore` pages by keyset on `(run_id, seq)`, `pageSize` (constructor option, default 5000) rows at a time.
- `listRuns`: newest first by `createdAt`, ties broken by `runId` descending; `limit: 0` yields `[]`. `before` is an ISO `createdAt` cursor: it returns runs created **strictly earlier** than it, so a client pages by passing the last row's `createdAt`. Runs with an identical `createdAt` can therefore be skipped across pages (a `(createdAt, runId)` cursor would fix that and is a spec change); callers (`run-service`, `ui-server`) inherit this.
- `subscribe` takes `{ fromSeq, signal }` only. `fromSeq` is inclusive (values below 1 are clamped to 1). Its polling interval is **not** a `subscribe` option: `pollMs` (default 100 ms) is a constructor option of `PgStore` and `MemoryStore`. `MemoryStore` additionally wakes its subscribers directly on every `create`/`append`. LISTEN/NOTIFY is deferred.

### Postgres schema (`001_init.sql`)

```sql
create table runs   (run_id uuid primary key, flow_id text not null, flow_name text not null,
                     status text not null, created_at timestamptz not null, updated_at timestamptz not null,
                     last_seq bigint not null);
create index runs_status_created on runs (status, created_at desc);
create table events (run_id uuid not null references runs, seq bigint not null, ts timestamptz not null,
                     type text not null, payload jsonb not null, primary key (run_id, seq));
```

`schema_migrations (version int primary key, applied_at timestamptz not null default now())` is **not** in `001_init.sql`: `migrate()` itself runs `create table if not exists schema_migrations ...` before applying anything.

`migrate(pool, { dirs? })` applies this package's `migrations/` plus any extra directories other packages register (e.g. `@loopwork/runtime`), in numeric filename order across all of them, and resolves to `{ applied: number[] }`. Each migration runs in its own transaction together with its `schema_migrations` row. It is idempotent, takes `pg_advisory_lock` (one fixed key, so it is database-wide: concurrent `migrate` calls in different schemas of one database serialize too), and refuses to run if `schema_migrations` contains a version it doesn't know (`SchemaTooNewError`, newer database than code). The same version number in two directories is `MigrationConflictError`. A migration with a lower version than one already applied is applied out of order without complaint, so never add lower versions after higher ones shipped.

## foldRun

```ts
foldRun(events: Iterable<LoopworkEvent>): RunState          // pure, deterministic, order-sensitive
applyEvent(state: RunState, e: LoopworkEvent): RunState     // incremental form; foldRun = reduce(applyEvent)
```
`RunState` (shared by the engine, for resume, and by `run-service`, for views) contains: `status`, `flow`, `lastSeq`,
`attempt`, `failure?`, per-node `{started, succeeded, failed, inFlight: Map<itemId, attempt>}`, per-edge `{emitted, consumed}`,
per-frame `{iterationsStarted, iterationsEnded, exitedCount, active: Map<itemId, {iteration, elapsedMs, breached}>}` (one entry per live frame instance), `sourcesCompleted`, the
set of **committed items** (step `StepSucceeded` per `(node, itemId)`), a bounded `recentErrors` (last 50), and
`sideEffects: Map<(node,itemId,key), JsonValue>`. `applyEvent` mutates a state it owns for speed; `foldRun`
over 1M events must stay under 5 s.

Fold semantics as implemented in `fold.ts` and pinned by `fold.test.ts` (except where a bullet says otherwise); `engine-core` and `run-service` build on these:

- `emptyRunState()` is `{ status: 'queued', lastSeq: 0, attempt: 0 }` with empty maps and sets. `attempt` is the **highest** `RunStarted.attempt` seen (not the last), consistent with resume = `attempt + 1`. The first event must be `RunCreated` (else `InvalidEventError`).
- Edge counters are keyed by edge id (`SPEC-graph-model.md`) over the flattened, scoped edges of the `RunCreated` flow (body edges included), each pre-populated with `{ emitted: 0, consumed: 0 }`. There are no synthetic entry/exit edges.
- An item's producer is the last `>`-separated segment of its `itemId` without the trailing `#k`. `consumed` increments on `StepStarted` only when `attempt === 1` (retries do not consume again), and on `FrameEntered` (which consumes the frame's `in` edge). `emitted` increments on `ItemEmitted` (the node's `out`) and on each output of `StepSucceeded`.
- A frame's body exit endpoint `F.<exit.node>.<exit.port>` is aliased to `F.out`: edges leaving `F.out` count the body exit's outputs as emitted and consumed. For `while`/`until` the body exit does not emit on `F.out` (those frames emit only their final state). Every emission on a frame port other than the aliased body exit (while/until `out`, retry `error`) is carried by `FrameExited.outputs` and counted from there, so a zero-iteration `while` and a retry `emit-error` both count.
- `nodes[n].started` counts every `StepStarted`. `inFlight` maps the item to the attempt of its latest `StepStarted`, and loses it on `StepSucceeded` and on `StepFailed` with `willRetry: false`. A `StepFailed` with `willRetry: true` keeps it, so a crash before the next `StepStarted` leaves the item resumable (resume re-runs it with `attempt + 1`, backoff restarting in full). `attempt` counts executions, including ones cut short by a crash. `committed` is added to only by `StepSucceeded`. `recentErrors` gets one entry per `StepFailed`, the latest 50 kept.
- `frames` is keyed by scoped node id; each holds the live **instances** keyed by the `FrameEntered.itemId`, carrying `{iteration, elapsedMs, breached}`. An instance is created on `FrameEntered`, advanced by `IterationStarted`/`IterationEnded` (`elapsedMs` accumulates `IterationEnded.elapsedMs`), marked `breached` by `BudgetExceeded`, and **deleted** on its `FrameExited` (so fold memory is bounded by live instances); `exitedCount` increments. A `foreach` emits `FrameEntered`/`FrameExited{input-done}` per input item, so each item is its own instance; "all input done" is derived (`in` closed, no active instances), not an event.
- `RunStarted` clears `failure` (a resume reopens a failed run). `BudgetExceeded` has no effect on the folded state (the status change comes from the `RunFailed` that follows).

## Code Style

```ts
export async function* read(this: PgStore, runId: string, opts: ReadOpts = {}): AsyncIterable<LoopworkEvent> {
  // keyset pagination on (run_id, seq), 5000 rows per page, never OFFSET
}
```

## Testing Strategy

A shared **store contract suite** (`runStoreContract(name, makeStore, opts?)`, `test/store-contract.ts`) runs against both implementations
(`memory-store.test.ts`, `pg-store.pg.test.ts`); every `makeStore()` call returns a store over empty tables. Fold has its own unit tests with hand-built event logs.
Postgres tests create a throwaway schema (`t_<random hex>`, dropped on dispose) per `withTestSchema()` call; they run in the `pg` vitest project (`pnpm test:pg`), which needs `LOOPWORK_TEST_DATABASE_URL`.

## Boundaries

- Always: keep both stores behaviorally identical (contract suite); batch inserts with `unnest` or multi-row `insert`; page reads by keyset.
- Ask first: changing an event's fields; a second migration after first release.
- Never: `UPDATE` or `DELETE` rows in `events`; store anything but JSON in `payload`; let `fold.ts` import `pg`.

## Success Criteria

- **EL-1** Both stores pass the identical contract suite: create/append/read ordering, gapless `seq`, `limit`/`fromSeq`.
- **EL-2** Appending with a stale `expectedSeq` throws `SeqConflictError` and writes nothing (atomic).
- **EL-3** Two concurrent appenders with the same `expectedSeq`: exactly one succeeds (Postgres test).
- **EL-4** After a terminal event, appends are rejected with `E_RUN_CLOSED`; the explicit-resume `RunStarted` on a `failed` run is accepted and flips status to `running`.
- **EL-5** `subscribe` delivers history then new events in order, with no duplicates and no gaps, and ends when the signal aborts.
- **EL-6** `runs` projection always equals `statusOf(foldRun(events))` (property test over random valid logs).
- **EL-7** `foldRun` is deterministic: same events, same state; and `foldRun(a ++ b) == applyEvent*(foldRun(a), b)`.
- **EL-8** Appending 100k events in batches of 500 completes in under 20 s on the CI Postgres (initial target; recalibrate after the first measurement and record it in this spec).
  *Measured:* median 5,948 ms (min 5,788, max 6,877; 5 runs, one local WSL2 machine, Postgres 16 in docker on tmpfs, Node 20.20.2; see `docs/develop/measurements/event-log.md`). The 20 s target is unchanged; recalibrate after the first CI run. Single-event append latency grows with run length (p50 7.3 ms on a fresh run, 20.6 ms after 100k events) because the `lastAttempt` lookup scans the run's `RunStarted` events and `events.type` has no index.
- **EL-9** `migrate` is idempotent, serialized under concurrent callers, and refuses a newer-than-known schema.
- **EL-10** Reading a 1M-event run uses constant memory (async iteration with keyset pages; asserted by page-size spy). *As verified:* the test asserts the size-independent property (no page query returns more than `pageSize` rows, none uses `OFFSET`, an early `break` stops paging) on a 50,321-event run with `pageSize` 1,000; the 1M-event run itself is not materialised.

## Open Questions

Retention and compaction are out of scope (ADR 0002, Phase 3). Large item values live inline in `payload`; revisit
if a real flow produces multi-MB items.
