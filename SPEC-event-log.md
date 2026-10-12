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

## Project Structure

```
packages/eventlog/
  src/events.ts          LoopworkEvent union, NewEvent, EVENT_TYPES
  src/store.ts           EventStore interface, SeqConflictError
  src/memory-store.ts
  src/pg-store.ts
  src/migrate.ts         migrate(pool): applies migrations/*.sql in order
  src/fold.ts            foldRun, emptyRunState, applyEvent
  migrations/001_init.sql
  test/
```

## Events

Every stored event is `{ runId, seq, ts, type, ...payload }`. `seq` is per run, starts at 1, gapless. `node` is
always a **scoped node id** (`frame.inner.node`, see `SPEC-graph-model.md`). `itemId` is deterministic:
source items `${node}.out#${index}`; step outputs `${inputItemId}>${node}.${port}#${k}`. Replaying a step
therefore reproduces identical ids.

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
  | { type: 'FrameExited';     node: string; itemId: string; reason: 'input-done'|'condition'|'success'|'retries-exhausted' }
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
- Appending may include a terminal event (`RunSucceeded|RunFailed|RunCancelled`); after one, further appends are rejected (`E_RUN_CLOSED`) **except** a `RunStarted` with a higher attempt when the status is `failed` (explicit resume, see `SPEC-run-service.md`).
- The Postgres store maintains a `runs` projection row **in the same transaction** as the append (status from the latest terminal/started event, `last_seq`, `updated_at`).
- `subscribe` polls every 100 ms by default (`pollMs` option); LISTEN/NOTIFY is deferred.

### Postgres schema (`001_init.sql`)

```sql
create table runs   (run_id uuid primary key, flow_id text not null, flow_name text not null,
                     status text not null, created_at timestamptz not null, updated_at timestamptz not null,
                     last_seq bigint not null);
create index runs_status_created on runs (status, created_at desc);
create table events (run_id uuid not null references runs, seq bigint not null, ts timestamptz not null,
                     type text not null, payload jsonb not null, primary key (run_id, seq));
create table schema_migrations (version int primary key, applied_at timestamptz not null default now());
```

`migrate(pool, { dirs? })` applies this package's `migrations/` plus any extra directories other packages register (e.g. `@loopwork/runtime`), in numeric filename order across all of them. It is idempotent, takes `pg_advisory_lock`, and refuses to run if `schema_migrations` contains a
version it doesn't know (newer database than code).

## foldRun

```ts
foldRun(events: Iterable<LoopworkEvent>): RunState          // pure, deterministic, order-sensitive
applyEvent(state: RunState, e: LoopworkEvent): RunState     // incremental form; foldRun = reduce(applyEvent)
```
`RunState` (shared by the engine, for resume, and by `run-service`, for views) contains: `status`, `flow`, `lastSeq`,
`attempt`, `failure?`, per-node `{started, succeeded, failed, inFlight: Set<itemId>}`, per-edge `{emitted, consumed}`,
per-frame `{iterationsStarted, iterationsEnded, active: Set<itemId>, elapsedMs, exited}`, `sourcesCompleted`, the
set of **committed items** (step `StepSucceeded` per `(node, itemId)`), a bounded `recentErrors` (last 50), and
`sideEffects: Map<(node,itemId,key), JsonValue>`. `applyEvent` mutates a state it owns for speed; `foldRun`
over 1M events must stay under 5 s.

## Code Style

```ts
export async function* read(this: PgStore, runId: string, opts: ReadOpts = {}): AsyncIterable<LoopworkEvent> {
  // keyset pagination on (run_id, seq), 5000 rows per page, never OFFSET
}
```

## Testing Strategy

A shared **store contract suite** (`runStoreContract(makeStore)`) runs against both implementations
(`memory-store.test.ts`, `pg-store.pg.test.ts`). Fold has its own unit tests with hand-built event logs.
Postgres tests create a throwaway schema per test file.

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
- **EL-9** `migrate` is idempotent, serialized under concurrent callers, and refuses a newer-than-known schema.
- **EL-10** Reading a 1M-event run uses constant memory (async iteration with keyset pages; asserted by page-size spy).

## Open Questions

Retention and compaction are out of scope (ADR 0002, Phase 3). Large item values live inline in `payload`; revisit
if a real flow produces multi-MB items.
