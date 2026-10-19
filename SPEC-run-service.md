# Spec: run-service (`@loopwork/service`)

Depends on: `graph-model`, `event-log`, `durable-runtime` (and `engine-core` for the registry). Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The one programmatic API every front door (CLI, MCP, GUI server) calls. It owns configuration, registry loading,
input validation, error codes, and the **view** of a run. Front doors never touch Postgres, the engine or the
queue directly. If a front door needs something this API lacks, the API grows; the front door does not reach around it.

## Tech Stack

TypeScript, `pg`. No new dependencies.

## Commands

```
pnpm --filter @loopwork/service test         # in-memory store
pnpm --filter @loopwork/service test:pg
```

## Project Structure

```
packages/service/
  src/service.ts        createService(opts): Service
  src/config.ts         loadConfig(): resolves DATABASE_URL, registry modules, flows dir
  src/registry.ts       loadRegistry(paths): builtins + user modules
  src/view.ts           toRunView(state, jobInfo): RunView
  src/watch.ts          watchRun: coalescing incremental view stream
  src/doctor.ts
  src/errors.ts         ServiceError, codes
  test/
```

## Configuration

Resolved in order: explicit options → env → `loopwork.config.json` found by walking up from cwd (or `LOOPWORK_CONFIG`).

```json
{ "databaseUrl": "postgres://…", "registry": ["./loopwork.fns.mjs"], "flowsDir": "./flows" }
```
Env: `DATABASE_URL` (or `LOOPWORK_DATABASE_URL`, which wins), `LOOPWORK_CONFIG`. Registry modules are ESM files whose
default export is `(registry: NodeRegistry) => void`; they execute user code with the user's own privileges, which
is the point (documented, not sandboxed in Phase 1). The worker process loads the **same** config, so a flow
started by any front door resolves the same functions.

## Contract

```ts
createService(opts?: ServiceOptions): Promise<Service>   // connects, runs migrations if config allows (autoMigrate default true)

interface Service {
  validateFlow(input: unknown): ValidationReport;                  // graph validation + registry check; pure, no DB
  startRun(req: { flow: unknown; input?: JsonValue; createdBy: 'cli'|'mcp'|'ui'|'api' }): Promise<{ runId: string }>;
  resumeRun(runId: string): Promise<{ runId: string; queued: true }>;
  cancelRun(runId: string): Promise<{ runId: string; state: 'cancelling' | 'cancelled' }>;
  inspectRun(runId: string): Promise<RunView>;
  listRuns(f?: { status?: RunStatus | 'stalled'; limit?: number /* default 50, max 200 */; before?: string }): Promise<RunSummary[]>;
  followRun(runId: string, o?: { fromSeq?: number; signal?: AbortSignal }): AsyncIterable<LoopworkEvent>;   // ends after the terminal event
  watchRun(runId: string, o?: { minIntervalMs?: number /* default 100 */; signal?: AbortSignal }): AsyncIterable<RunView>;
  readEvents(runId: string, o: { fromSeq?: number; limit: number /* max 500 */; types?: string[] }): Promise<{ events: LoopworkEvent[]; nextSeq: number | null }>;
  listFlows(): Promise<FlowFile[]>;                                // *.flow.json under flowsDir
  readFlow(name: string): Promise<unknown>;                        // name resolved inside flowsDir; traversal rejected
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}
```

- `startRun`: validate (`E_VALIDATION` with the full error list), check every `fn` against the registry (`E_UNKNOWN_FN`
  with the names), generate `runId = crypto.randomUUID()`, `store.create(RunCreated)`, `enqueue`, `ensureWorker`. Returns
  immediately. It never waits for execution. An optional `idempotencyKey` is **not** in Phase 1.
- `resumeRun`: only if status is `failed` with reason `step | crash-loop | internal`, or the run is `stalled`
  (stalled runs resume automatically by lease expiry; this just nudges `ensureWorker`). Else `E_NOT_RESUMABLE` with the reason
  (`succeeded`, `cancelled`, `budget`, `running`, `queued`).
- `cancelRun`: `queued`/`running`/`stalled` only; terminal runs → `E_NOT_CANCELLABLE`. Idempotent for `cancelling`.
- `watchRun`: yields a full `RunView` first, then updated views at most every `minIntervalMs`, only when something
  changed, computed **incrementally** with `applyEvent` (never re-folds the log per message). Ends after the terminal
  view. Constant memory regardless of run length.
- `readEvents`: paging for drill-down (e.g. error list, one frame's iterations); `types` filters server-side.

### RunView

```ts
type RunView = {
  runId: string; flowId: string; flowName: string;
  status: 'queued'|'running'|'succeeded'|'failed'|'cancelled'|'stalled';
  cancelRequested: boolean; createdAt: string; startedAt?: string; endedAt?: string; lastSeq: number; attempt: number;
  failure?: { reason: string; message: string; node?: string };
  nodes: Record<string, { kind: string; state: 'idle'|'running'|'done'|'failed'; started: number; succeeded: number; failed: number; inFlight: number }>;
  edges: Record<string, { emitted: number; consumed: number }>;           // keyed by edgeId
  frames: Record<string, { frame: string; iterationsStarted: number; iterationsEnded: number; active: number; exitedCount: number;
                           budgets: { iterations: { used: number; limit: number }; time: { usedMs: number; limitMs: number; breached: boolean } } }>;
  recentErrors: { seq: number; node: string; itemId: string; message: string; willRetry: boolean }[];   // ≤ 50
  flow: Flow;                                                             // for rendering
};
```
`toRunView` derives the counts from the `foldRun` state (`SPEC-event-log.md`): `nodes[].inFlight` = the node's `inFlight.size`;
per frame, `active` = `active.size` (live instances), `exitedCount` = finished instances (a frame has one instance per `foreach` item, so there is no
single `exited` flag), `time.usedMs` = the sum of `elapsedMs` over the live instances, and `time.breached` = any live instance is `breached`.
`stalled` = log says `running` but the job's lease has expired (worker dead). It is a view-level status, never an event.

### Errors

`ServiceError { code, message, details? }`. Codes (stable): `E_VALIDATION`, `E_UNKNOWN_FN`, `E_NOT_FOUND`,
`E_NOT_RESUMABLE`, `E_NOT_CANCELLABLE`, `E_CONFIG`, `E_DB_UNREACHABLE`, `E_BAD_REQUEST`, `E_INTERNAL`. Each front door
maps these in its own spec (CLI exit codes, HTTP statuses, MCP `isError`). Unknown exceptions are wrapped as `E_INTERNAL`.

### doctor

`DoctorReport = { ok: boolean; checks: { id: string; ok: boolean; message: string; fix?: string }[] }`. Checks: `node-version (>=22)`,
`config`, `database-connect`, `migrations-current`, `worker-alive` (informational), `registry-loads`, `flows-dir`. Each failed check carries a
one-line `fix` (e.g. `run: loopwork init`).

## Code Style

```ts
async function resumeRun(runId: string) {
  const view = await this.inspectRun(runId);
  if (!isResumable(view)) throw new ServiceError('E_NOT_RESUMABLE', `run is ${describe(view)}`, { status: view.status });
  await store.append(runId, [{ type: 'RunStarted', workerId: 'pending', attempt: view.attempt + 1 }], { expectedSeq: view.lastSeq });
  await enqueue(pool, runId); await ensureWorker(workerOpts);
  return { runId, queued: true as const };
}
```

## Testing Strategy

Unit tests on `MemoryStore` with an injectable fake queue for validation, view mapping, resumability rules, errors,
flow-file path safety. `*.pg.test.ts` for the full path (`startRun` → worker in-process → `succeeded`), cancel, resume,
`watchRun` coalescing. The test suite includes a **contract test per method** that front-door specs reference by id.

## Boundaries

- Always: validate at this boundary even if the front door already did; return stable error codes; keep every method safe to call concurrently.
- Ask first: adding or changing a method signature, a `RunView` field or an error code (three specs depend on them).
- Never: write to stdout; let `readFlow` read outside `flowsDir`; log `databaseUrl` (redact the password in any message and in `doctor`); import `ui-server`, `cli`, `mcp-server`.

## Success Criteria

- **RS-1** `validateFlow` reports every graph error and every unknown `fn` in one result, without a database.
- **RS-2** `startRun` returns in under 200 ms for the `foreach-100k` fixture (it only enqueues), and the run reaches `succeeded` with a worker running.
- **RS-3** `startRun` with an invalid flow writes nothing (no run row, no job).
- **RS-4** `resumeRun`/`cancelRun` enforce the state rules above, each rejection with its `E_*` code and `details.status`.
- **RS-5** After `kill -9` of the worker, `inspectRun` shows `stalled` once the lease expires; `listRuns({status:'stalled'})` includes it; after takeover it is `running`, then terminal.
- **RS-6** `watchRun` on a 100k-item run yields at most `1000 / minIntervalMs` views per second, the final view is terminal, and counters in successive views never decrease.
- **RS-7** `watchRun` memory stays flat (no per-event retention) over a 1M-event run.
- **RS-8** `readEvents` paging reconstructs the full log with no gaps; `limit > 500` is clamped.
- **RS-9** `readFlow('../../etc/passwd')`, absolute paths, and names with `\` or NUL are rejected `E_BAD_REQUEST`; only `*.flow.json` inside `flowsDir` are served.
- **RS-10** `doctor` fails with a specific `fix` for: no `DATABASE_URL`, unreachable DB, pending migrations, broken registry module; and never prints the DB password.
- **RS-11** A registry module that throws on load makes `createService` fail with `E_CONFIG` naming the file; the worker process fails the same way (visible in `doctor`).
- **RS-12** `followRun` from `fromSeq: 1` returns the whole log and ends after the terminal event; aborting the signal ends it promptly.

## Open Questions

Idempotency keys for `startRun` (de-duplicating a retried call from an MCP client) are deferred; revisit if duplicate runs appear in practice.
