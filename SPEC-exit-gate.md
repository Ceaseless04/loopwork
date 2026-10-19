# Spec: exit-gate (`tests/e2e`)

Depends on: all modules. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The Phase 1 definition of done, executable. Proves the exit criterion from `docs/PLAN.md`: **a 100k-item loop with a
concurrency limit completes and survives `kill -9` mid-run**, driven from the CLI and from an MCP client, with the GUI
server's stream and interactive actions asserted live. Anything that cannot run headless is a written manual checklist.

## Tech Stack

vitest (`*.e2e.test.ts`), real Postgres (docker compose), real child processes. The MCP client uses `@modelcontextprotocol/sdk`'s stdio client. No new dependencies.

## Commands

```
docker compose -f docker-compose.test.yml up -d
pnpm -r build
pnpm test:e2e                             # all scenarios
pnpm test:e2e -- scenarios/kill9-cli      # one scenario
LOOPWORK_E2E_ITEMS=2000 pnpm test:e2e     # fast mode (default 100000)
```

## Project Structure

```
tests/e2e/
  harness/{postgres.ts,process.ts,cli.ts,mcp.ts,ui.ts,invariants.ts}
  fixtures/gate-100k.flow.json       source range(N) → foreach(concurrency 32){ map tag } → sink pgIdempotent
  fixtures/loop-demo.flow.json       while/retry demo used by GUI scenarios
  scenarios/{kill9-cli,kill9-mcp,chaos,gui-live,gui-interactive,boundaries}.e2e.test.ts
docs/MANUAL-CHECKLIST.md
```

## The gate flow

`source range{count: N}` → `foreach` (`concurrency: 32`, budgets `maxIterations: N`, `maxDurationMs: 900000`) with body `map tag` → `sink pgIdempotent{table: e2e_sink}`. N defaults to 100,000.
The sink inserts `idempotencyKey` into `e2e_sink` with `ON CONFLICT DO NOTHING`, so at-least-once re-execution after a crash is observable as **attempts**, while correctness is the **row count**.

## Invariants (`invariants.ts`, asserted by every scenario)

1. Run status is `succeeded`.
2. `select count(*), count(distinct key) from e2e_sink` = `N, N`.
3. In the log: exactly one `StepSucceeded` per `(node, itemId)`; `seq` is gapless from 1; exactly one terminal event, last; at least `kills + 1` `RunStarted` events with strictly increasing `attempt`.
4. Every `BudgetExceeded` count is 0.
5. The worker's peak RSS (sampled from `/proc/<pid>/status` or `ps`) stays under 512 MB.
6. Wall time under 300 s on the CI runner (initial target; recalibrate after the first recorded run and write the measured numbers into this spec).

## Scenarios

**kill9-cli.** `loopwork init` in a temp dir pointing at the test DB → `loopwork run gate.flow.json` (detached) → poll `inspect --json` until ≥ 30% of items committed → `kill -9` the worker pid from the `workers` table → assert `inspect` reports `stalled` after lease expiry → wait for takeover (an auto-spawned worker or a started `loopwork worker`) → wait for terminal → invariants.

**kill9-mcp.** Same flow through a stdio MCP client against `loopwork mcp`: `run_flow` (returns in < 500 ms), `wait_for_run` loops, `kill -9` the worker, keep polling, invariants. Also asserts every MCP stdout line is JSON-RPC.

**chaos.** N = 20,000, three `kill -9`s at random commit counts (seeded; the seed is printed on failure), plus one `SIGSTOP`/`SIGCONT` zombie of the old worker after takeover. Invariants hold; the zombie's writes are absent after it resumes (fenced).

**gui-live.** Start `loopwork ui --no-open --print-url`, read the URL, follow the redirect to obtain the cookie, open `/api/runs/:id/stream`. During the kill9 run assert: first message is a full view; ≤ 10 messages/s; counters never decrease across the crash and takeover; a `stalled` view appears and later a `running` one; final view is `succeeded`.

**gui-interactive.** Through the HTTP API with a valid session: `POST /api/runs` starts `loop-demo`; `POST /cancel` ends it `cancelled`; a run failed on purpose (`failEvery`) is `POST /resume`d and ends `succeeded` after the fault is removed from the registry module; invalid transitions return 409. Then the same checks with a missing cookie, wrong `Host`, wrong `Origin` (all rejected).

**boundaries.** `loopwork doctor` passes on a healthy setup and fails with the right `fix` for a stopped Postgres; `loopwork open --no-gui --no-terminal <flow>` starts a run and prints the run id; `LOOPWORK_TERMINAL` set to a script that records argv proves `open` hands the launcher the right command.

## Manual checklist (`docs/MANUAL-CHECKLIST.md`, filled in per release; results recorded with date and environment)

1. WSL2 + Windows 11: in Claude Code CLI run `/loopwork`; a Windows Terminal window and an app-mode browser window open; closing the terminal does not stop the run; `loopwork follow <id>` re-attaches.
2. `/loopwork gate.flow.json`: both windows show the new run; GUI edge counts and frame iteration move; **Cancel** in the GUI cancels; **Resume** on a failed run works.
3. Same from Claude Desktop's Code tab.
4. Claude Desktop chat with the MCPB bundle (and separately the WSL config snippet): ask to run `loop-demo`, get a run id, check status, ask to open the GUI (`open_gui`).
5. macOS and Linux (with and without a display): `loopwork open` opens windows or prints a usable fallback.
6. Close Claude Desktop mid-run; the run completes; reopening and asking for status works.
7. Kill the machine's Postgres container mid-run and restart it: workers recover, the run completes or fails with a clear message (no silent loss).
8. Idle GUI server exits after its timeout and `loopwork open` starts a fresh one.

## Code Style

```ts
test('kill -9 mid-run: exactly-once commit, no loss', async () => {
  const run = await cli.run(GATE_FLOW, { items: N });
  await waitUntil(() => committedFraction(run.id) >= 0.3);
  await kill9(await workerPid(run.id));
  await expectStalledThenRunning(run.id);
  await waitTerminal(run.id, { timeoutMs: 300_000 });
  await assertInvariants(run.id, { items: N, kills: 1 });
}, 360_000);
```
Poll with explicit conditions and timeouts; never fixed sleeps as synchronisation.

## Testing Strategy

The gate is run in CI on every PR in **fast mode** (`LOOPWORK_E2E_ITEMS=2000`, kill9-cli, kill9-mcp, gui-interactive, boundaries) and in **full mode** (100k, all scenarios) nightly and before a release. Flaky = a bug: scenarios must be deterministic given their seed; quarantine is not allowed.

## Boundaries

- Always: use a throwaway database/schema per scenario; kill by pid from the `workers` table (never by name); print the seed and the run id on failure; clean up child processes in `afterAll`.
- Ask first: raising a time or memory threshold (recalibrating needs a recorded measurement); skipping a scenario on any platform.
- Never: weaken an invariant to get green; mock Postgres, the worker or the CLI in these tests; run against a developer's real database.

## Success Criteria

- **XG-1** kill9-cli passes in full mode (N = 100,000, one `kill -9`) with all invariants.
- **XG-2** kill9-mcp passes in full mode through the stdio MCP client.
- **XG-3** chaos passes for 5 different seeds in a row, including the zombie worker being fenced.
- **XG-4** gui-live asserts the stream properties (first full view, rate ≤ 10/s, monotonic counters, `stalled` then `running`, terminal `succeeded`).
- **XG-5** gui-interactive covers start, cancel, resume, 409s, and all three security rejections.
- **XG-6** boundaries passes; `doctor` failure messages are actionable.
- **XG-7** fast mode runs in under 10 minutes in CI; the thresholds in invariants 5–6 are replaced by recorded measurements after the first full run.
- **XG-8** `docs/MANUAL-CHECKLIST.md` exists with every item above and has been executed once on the target machine (WSL2 + Windows 11) with results recorded before Phase 1 is declared done.
- **XG-9** Phase 1 done = XG-1…XG-8 plus every success criterion in every module spec mapped to a passing named test.

## Open Questions

Throughput expectations (items/s) are deliberately not asserted yet; first measurement from XG-1 becomes the baseline and a regression guard in a follow-up.
