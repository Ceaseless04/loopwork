# Capability Map: Loopwork Phase 1

Status: **approved.** Module specs: `SPEC-<module-id>.md` at the repo root, one per module below.
Context: [docs/PLAN.md](docs/PLAN.md), [ADR 0003](docs/adr/0003-one-engine-many-front-doors.md).

## Goal

One engine, four front doors, all sharing the same Postgres:

1. **`loopwork` CLI**: validate / run / resume / cancel / inspect / follow.
2. **`/loopwork` in Claude Code** (CLI, and the Code tab in Claude Desktop): pops open a
   **new terminal window** running the CLI **and a GUI window** showing the live run.
3. **GUI window**: an **interactive** local app. Start a flow, watch the graph live (edge counts,
   frame iterations, errors), resume or cancel a run. It is the seed Phase 2's editable canvas grows from.
4. **Claude Desktop chat**: the same operations as MCP tools.

Exit: a 100k-item loop with a concurrency limit completes and survives `kill -9` mid-run,
driven from the terminal **and** from an MCP client, and visible live in the GUI.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `graph-model` | Typed graph IR, frame types, mandatory budgets and exit conditions, schema inference, static validation (outer graph is a DAG, wiring type-checks, budgets present) | none |
| `event-log` | Event schema, `EventStore` interface, in-memory and Postgres implementations, migrations, fold-to-run-state | `graph-model` (types only) |
| `window-launcher` | Open a new window per platform, two kinds: **terminal** running an argv (WSL2 to Windows Terminal via `wt.exe`, macOS Terminal/iTerm, Linux `x-terminal-emulator`/`gnome-terminal`/`kitty`) and **app window** for a URL (Chrome/Edge `--app=URL` for a chromeless window, else the default browser). Returns launched / unsupported with a printable fallback. | none |
| `engine-core` | In-process executor: streaming items, concurrency limit, backpressure, frame semantics and budget stops. Runs against any `EventStore`. Ships the built-in node functions. | `graph-model`, `event-log` |
| `durable-runtime` | Postgres `SKIP LOCKED` job queue, detached worker, leases, heartbeats and fencing, cancel signal, resume-from-log after a crash | `event-log`, `engine-core` |
| `run-service` | Programmatic API shared by every front door: `validateFlow`, `startRun` (enqueue, returns run id immediately), `resumeRun`, `cancelRun`, `inspectRun`, `listRuns`, `followRun` (raw event stream), `watchRun` (coalesced run-view stream). Owns config and `doctor` checks. | `graph-model`, `event-log`, `durable-runtime` |
| `ui-server` | Local HTTP server on `node:http`: JSON endpoints, coalesced Server-Sent Events, serves the viewer's built assets. Binds `127.0.0.1` only, random port, per-launch token, Host/Origin checks. **Read and write** (start, resume, cancel). | `run-service` |
| `ui-viewer` | React + React Flow single-page **interactive** app: flow launcher, run list, graph with live edge item counts and throughput, frame cards with iteration counter and budget bars, error panel, resume/cancel controls. Built with Vite. Phase 2 extends it into the editable canvas. | `ui-server` (API contract) |
| `cli` | `loopwork` binary over `run-service`: `validate`, `run`, `resume`, `cancel`, `inspect`, `list`, `follow`, `doctor`, `init`, `worker`, `ui`, `mcp`, and `open` (launch the terminal **and** the GUI via `window-launcher`). Exit codes are part of the contract. | `run-service`, `window-launcher`, `ui-server` |
| `mcp-server` | Stdio MCP server over `run-service`. Tools mirror the CLI. `run_flow` returns a run id immediately and never blocks the client. | `run-service` |
| `claude-integration` | `/loopwork` command for Claude Code (calls `loopwork open`; works in the CLI and Desktop's Code tab), plugin with MCP registration, Claude Desktop packaging (`.mcpb` bundle plus a `claude_desktop_config.json` snippet, WSL variant included), bundles `ui-viewer` assets, install check. | `cli`, `mcp-server`, `ui-viewer` |
| `exit-gate` | End-to-end proof: 100k-item loop + `kill -9` resume through the CLI and through the MCP server, GUI stream and interactive actions asserted live. Also a manual checklist for the terminal window, GUI window and Desktop install, which cannot run headless. | all of the above |

## Build order

`graph-model` ∥ `window-launcher` → `event-log` → `engine-core` → `durable-runtime` → `run-service` → `ui-server` ∥ `mcp-server` → `cli` ∥ `ui-viewer` → `claude-integration` → `exit-gate`

## Boundaries between modules

- Front doors (`cli`, `mcp-server`, `ui-server`, `claude-integration`) never touch Postgres or the engine directly, only `run-service`. The contract lives in `SPEC-run-service.md`.
- `ui-viewer` talks only to `ui-server`'s HTTP/SSE contract, owned by `SPEC-ui-server.md`.
- `window-launcher` knows nothing about Loopwork. It takes an argv or a URL and opens a window.
- State is shared only through Postgres: a run started over MCP can be watched with `loopwork follow` in a terminal or in the GUI, and the reverse. There is no daemon and no IPC.

## Decisions (approved defaults)

1. **GUI shell:** local web server plus an app-mode browser window. No Electron or Tauri.
2. **GUI scope:** interactive. It can start flows, resume and cancel runs. Editing the graph is Phase 2.
3. **`/loopwork`** is one command, working in the Claude Code terminal and in Desktop's Code tab.
4. **WSL2:** the Desktop config runs `wsl.exe -e loopwork mcp`; the GUI server runs in WSL2 and the Windows browser reaches it over localhost forwarding. Native Windows Node is untested in Phase 1.
5. **Postgres:** required. `loopwork init` writes a `docker compose` file for Postgres 16. No SQLite fallback (ADR 0002).
6. **Dependencies:** `pg`, `@modelcontextprotocol/sdk`, `react`, `react-dom`, `@xyflow/react`, `vite`, `vitest`, `typescript`, `eslint`, `@testing-library/react`, `jsdom`. Everything else is stdlib: arg parsing with `util.parseArgs`, HTTP with `node:http`, no schema-validation library, no Express. Adding any other dependency is Ask-first.
7. **Terminal window content:** a plain live log from `run --follow`. No TUI.
8. **Events:** per-item events with batched inserts.
9. **Budget exhaustion:** `BudgetExceeded` event, run ends `failed` with reason `budget`.

## Repo-wide conventions (every module spec inherits these)

**Package layout:** `packages/{graph,eventlog,engine,runtime,service,windows,ui-server,mcp}`, `apps/{cli,ui-viewer}`, `integrations/claude`, `tests/e2e`. Scope `@loopwork/*`. pnpm workspace.

**Stack:** TypeScript 5 strict, ESM, Node 22 LTS, vitest, eslint.

**Commands (run from the repo root):**
```
pnpm install
pnpm -r build                 # tsc -b per package
pnpm typecheck
pnpm lint
pnpm test                     # unit tests, in-memory only, no Postgres, no network
pnpm test:pg                  # *.pg.test.ts, needs Postgres:
                              #   docker compose -f docker-compose.test.yml up -d
                              #   LOOPWORK_TEST_DATABASE_URL=postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test
pnpm test:e2e                 # tests/e2e, the exit gate
pnpm --filter @loopwork/<pkg> test
```
File suffixes: `*.test.ts` (no Postgres), `*.pg.test.ts` (Postgres), `*.e2e.test.ts` (spawns processes).

**Code style.** kebab-case files, named exports only, `.js` suffix on relative imports, no `any`, no `@ts-ignore`. Expected failures are returned as discriminated unions. Thrown errors are for infrastructure and programmer mistakes, and carry a stable `code`. Library code never writes to stdout.
```ts
export type ValidationResult =
  | { ok: true; flow: Flow }
  | { ok: false; errors: ValidationError[] };

export function validateFlow(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  // collect every error, don't stop at the first
  return errors.length ? { ok: false, errors } : { ok: true, flow: input as Flow };
}
```

**Testing levels.** Pure logic: unit tests. Anything touching Postgres: `*.pg.test.ts`. Anything spawning processes or opening ports: `*.e2e.test.ts`. A bug fix lands with a regression test. Coverage is not a target; every success criterion ID in a spec must map to at least one named test.

**Boundaries (all modules):**
- Always: tests for every success criterion; stable error codes; validate input at every trust boundary (files, HTTP, MCP, argv); additive-only event types.
- Ask first: any new dependency; changing an event type's shape; a new migration after the first release; CI config; changing a CLI exit code or MCP tool name.
- Never: commit secrets or `DATABASE_URL` values; edit an applied migration; weaken, skip or delete a test to get green; write to stdout from library code; bind a server to anything but `127.0.0.1`.

Run `constraint-driven-development` once before implementation starts, to write `CONSTRAINTS.md` and lock these in.
