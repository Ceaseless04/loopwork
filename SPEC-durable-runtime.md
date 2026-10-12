# Spec: durable-runtime (`@loopwork/runtime`)

Depends on: `event-log`, `engine-core`. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Turn `executeRun` into something that survives process death: a Postgres job queue (`FOR UPDATE SKIP LOCKED`),
a worker that claims runs under a time-limited lease, heartbeats, a cancel signal, and automatic takeover of a
dead worker's run, resuming from the event log. Also spawns a detached worker so a front door can return
immediately.

## Tech Stack

TypeScript, `pg`, `node:child_process` (detached spawn).

## Commands

```
pnpm --filter @loopwork/runtime test:pg
```

## Project Structure

```
packages/runtime/
  migrations/002_queue.sql      jobs, workers tables (continues numbering from eventlog's 001)
  src/queue.ts                  enqueue, claim, heartbeat, release, complete, requestCancel
  src/worker.ts                 runWorker(opts): claim loop + executeRun per claimed run
  src/spawn.ts                  ensureWorker(opts): start a detached `loopwork worker` if none is alive
  src/liveness.ts               workerAlive(), stalledRuns()
  test/
```

Migrations are applied by `@loopwork/eventlog`'s `migrate`; each package contributes files through a registered
directory list (`migrate(pool, { dirs })`), applied in numeric order.

## Schema (`002_queue.sql`)

```sql
create table jobs (
  run_id uuid primary key references runs,
  state text not null,                 -- queued | leased | done
  attempts int not null default 0,     -- number of takeovers; compared to maxAttempts
  lease_owner text, lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  cancel_requested boolean not null default false
);
create index jobs_claim on jobs (available_at) where state in ('queued','leased');
create table workers (worker_id text primary key, pid int, host text, started_at timestamptz not null,
                      heartbeat_at timestamptz not null);
```

## Contract

```ts
enqueue(pool, runId: string): Promise<void>                       // idempotent; requeues a 'done' job for explicit resume
requestCancel(pool, runId: string): Promise<void>
runWorker(opts: {
  pool: Pool; store: EventStore; registry: NodeRegistry; workerId?: string;
  leaseMs?: number;           // default 15_000
  heartbeatMs?: number;       // default 5_000 (must be < leaseMs / 2)
  pollMs?: number;            // default 500
  maxTakeovers?: number;      // default 5
  maxConcurrentRuns?: number; // default 4
  idleExitMs?: number;        // exit when no work for this long; default: never (0)
  signal: AbortSignal;        // graceful stop
}): Promise<void>
ensureWorker(opts: { pool: Pool; cmd: string[]; env?: NodeJS.ProcessEnv }): Promise<{ started: boolean; workerId?: string }>
workerAlive(pool: Pool, withinMs?: number /* default 3 * heartbeat */): Promise<boolean>
stalledRuns(pool: Pool): Promise<string[]>   // jobs in 'leased' with expired lease: log says running, nobody is
```

### Claim

```sql
update jobs set state='leased', lease_owner=$1, lease_expires_at=now()+$2*interval '1 ms', attempts=attempts + (state='leased')::int
where run_id = (select run_id from jobs
                where (state='queued' or (state='leased' and lease_expires_at < now())) and available_at <= now()
                order by available_at for update skip locked limit 1)
returning run_id, attempts, cancel_requested;
```
An expired lease **is** a crash: the next claim is a takeover, counted in `attempts`. When `attempts > maxTakeovers`,
the worker appends `RunFailed{reason:'crash-loop'}` instead of executing.

### Worker loop per claimed run

1. Fold the log for `lastSeq`; append `RunStarted{workerId, attempt}` with `expectedSeq`.
2. Start heartbeat (extends `lease_expires_at` **only** `where lease_owner = me`; if zero rows updated, the lease is lost: abort the executor and stop).
3. Poll `cancel_requested` every `pollMs`; on true, abort the executor's signal.
4. `executeRun(...)`. Outcome → `jobs.state = 'done'` for `succeeded|failed|cancelled`; `fenced` → drop the lease quietly, touch nothing.
5. Graceful stop (`signal`): stop claiming, abort executors, wait for them to flush, **release** leases (`state='queued'`, `lease_owner=null`) so another worker resumes at once.
6. On startup and every `heartbeatMs`: upsert own row in `workers`; delete rows older than 1 min.

### Explicit resume of a failed run

`run-service` appends a `RunStarted` (allowed by the event-log rule for `failed` runs) and calls `enqueue`. The
worker treats it like any other claim. A run that is `succeeded` or `cancelled`, or failed with
`reason:'budget'`, is rejected before this point by `run-service`.

### ensureWorker

Spawn `cmd` (e.g. `['/path/to/node','/path/to/loopwork','worker']`) with `detached: true`, `stdio: 'ignore'`,
`unref()`, **only if** `workerAlive` is false. Races between two callers are harmless: two workers are allowed, the
claim is exclusive. `idleExitMs` defaults to 10 min for spawned workers so abandoned ones disappear.

## Code Style

```ts
const claimed = await claim(pool, { workerId, leaseMs });
if (!claimed) { await sleep(pollMs, signal); continue; }
void runOne(claimed).catch((e) => log.error({ runId: claimed.runId, e }));   // never let one run kill the loop
```

## Testing Strategy

`*.pg.test.ts` against real Postgres. Time-based behavior uses short real durations (`leaseMs: 300`,
`heartbeatMs: 100`) rather than fake timers, since Postgres computes `now()`. Crash tests run the worker in a
child process and `kill -9` it (`*.e2e.test.ts`); the small-scale versions here (2k items) feed the exit gate's
100k version.

## Boundaries

- Always: heartbeat and every event append are fenced (`lease_owner`, `expectedSeq`); a lost lease aborts work immediately; log through an injected logger to stderr.
- Ask first: changing lease/heartbeat defaults; a second queue table; adding LISTEN/NOTIFY.
- Never: hold a DB transaction open while a step runs; delete `jobs` rows; mark a run `done` without a terminal event in the log; assume exactly one worker exists.

## Success Criteria

- **DR-1** `enqueue` + one worker runs a small flow to `succeeded`; `jobs.state='done'`.
- **DR-2** Two workers racing on N queued runs: every run is executed by exactly one worker at a time (no run has two concurrent `RunStarted` owners), proven with a slow step and assertion on `lease_owner`.
- **DR-3** `kill -9` of a worker mid-run: after lease expiry another worker claims it, appends `RunStarted{attempt+1}`, and the run completes with exactly one `StepSucceeded` per `(node,itemId)`.
- **DR-4** A paused ("zombie") worker whose lease was taken over fails its next heartbeat or append, returns `fenced`, and writes nothing further to the log (SIGSTOP/SIGCONT test).
- **DR-5** Heartbeat failure (lease lost) aborts the executor within one `heartbeatMs`.
- **DR-6** `requestCancel` on a running run yields `RunCancelled` within `2 * pollMs + grace`; on a queued run, the run is cancelled without a worker ever running it.
- **DR-7** A run that crashes its worker more than `maxTakeovers` times ends `failed{crash-loop}`; the worker keeps serving other runs.
- **DR-8** SIGTERM to a worker flushes, releases the lease, and a second worker resumes immediately (no lease-expiry wait).
- **DR-9** `ensureWorker` starts exactly one detached worker when none is alive, none when one is; the spawned process survives the caller exiting.
- **DR-10** `stalledRuns` returns a run whose worker was `kill -9`'d once its lease expires, and not before.
- **DR-11** `idleExitMs` makes an idle worker exit 0.

## Open Questions

None blocking. LISTEN/NOTIFY for instant claim is deferred; `pollMs` is the latency floor.
