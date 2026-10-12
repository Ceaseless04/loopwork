# Spec: mcp-server (`@loopwork/mcp`)

Depends on: `run-service`. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Expose Loopwork to Claude Desktop (and any MCP client) as tools over **stdio**. Same operations as the CLI, same
`run-service` underneath. A tool call never blocks the model for long: `run_flow` returns a run id at once and
progress is read with `inspect_run` / `wait_for_run`.

## Tech Stack

TypeScript, `@modelcontextprotocol/sdk` (new dependency; approved in the capability map). Tool input schemas use the SDK's zod re-export; no separate zod dependency.

## Commands

```
pnpm --filter @loopwork/mcp test
npx @modelcontextprotocol/inspector loopwork mcp        # manual inspection once cli exists
```

## Project Structure

```
packages/mcp/
  src/server.ts        createMcpServer(service, opts): McpServer ; serveStdio(service, opts)
  src/tools/*.ts       one file per tool: schema + handler
  src/format.ts        RunView -> compact text summary, truncation
  src/errors.ts        ServiceError -> tool error result
  test/
```

## Contract

```ts
createMcpServer(service: Service, opts: { openCommand: string[] | undefined /* argv for `loopwork open`, injected by cli */; version: string }): McpServer
serveStdio(server: McpServer): Promise<void>
```

Every tool returns **both** `content: [{ type:'text', text }]` (a short human summary) and `structuredContent` (JSON matching
its `outputSchema`). Failures return `isError: true` with `structuredContent: { error: { code, message, details? } }`; the server
never throws across the protocol.

| Tool | Input | Behaviour | Hints |
|---|---|---|---|
| `validate_flow` | `{ flow?: object, flowName?: string }` | `validateFlow`; reports all errors | readOnly |
| `list_flows` | `{}` | `listFlows` (files in `flowsDir`) | readOnly |
| `run_flow` | `{ flow?: object, flowName?: string, input?: any }` | `startRun(createdBy:'mcp')`; returns `{ runId }` immediately | not idempotent |
| `inspect_run` | `{ runId }` | compact summary + `RunView` with `flow` omitted and lists capped (50 nodes with activity, 20 errors) | readOnly |
| `wait_for_run` | `{ runId, timeoutMs?: ≤ 30000 }` | long-poll via `watchRun`: returns on terminal status or timeout; `{ done: boolean, view }` | readOnly |
| `list_runs` | `{ status?, limit?: ≤ 50 }` | `listRuns` | readOnly |
| `get_run_events` | `{ runId, fromSeq?, limit?: ≤ 200, types?: string[] }` | `readEvents` paging | readOnly |
| `resume_run` | `{ runId }` | `resumeRun` | |
| `cancel_run` | `{ runId }` | `cancelRun` | destructive |
| `open_gui` | `{ runId?: string, terminal?: boolean }` | spawns `openCommand` (`loopwork open [runId] [--no-terminal]`) detached; returns what launched or a fallback command | |

`flow` and `flowName` are mutually exclusive; exactly one is required for `validate_flow` and `run_flow` (`E_BAD_REQUEST` otherwise).
`open_gui` is disabled (tool absent) when `openCommand` is undefined.

**stdout hygiene:** stdout carries only protocol frames. Everything else, including `console.*`, the SDK's logs and uncaught
errors, goes to stderr. `serveStdio` replaces `console.log` with the stderr logger before doing anything else.

**Size limits:** no tool result exceeds 64 KB of text; larger results are truncated with an explicit
`"truncated": true, "hint": "use get_run_events with fromSeq=…"`.

## Code Style

```ts
server.registerTool('run_flow', {
  description: 'Start a flow run and return its run id immediately. Poll with inspect_run or wait_for_run.',
  inputSchema: { flow: z.record(z.unknown()).optional(), flowName: z.string().optional(), input: z.unknown().optional() },
}, async (args) => withService(() => runFlow(service, args)));
```
Tool descriptions are written for the model: say what it returns and which tool to call next.

## Testing Strategy

Handlers are tested through the SDK's in-memory client/server transport against a fake `Service`: every tool, success
and each error code. One `*.e2e.test.ts` spawns the real `loopwork mcp` over stdio (after the `cli` module exists), runs
initialize → list tools → `validate_flow`, and asserts stdout is protocol-only.

## Boundaries

- Always: validate tool input with schemas; map every `ServiceError`; keep results compact for the model; log to stderr.
- Ask first: renaming or removing a tool (clients may have it in prompts); adding a tool that deletes or overwrites data.
- Never: write anything but protocol frames to stdout; block a tool call longer than `timeoutMs` (max 30 s); expose file-reading tools (flows come from `flowsDir` or inline); import from `cli`.

## Success Criteria

- **MCP-1** `tools/list` returns exactly the documented tools with input and output schemas (snapshot test).
- **MCP-2** Each tool maps to the right `Service` method with parsed arguments (spy), and returns text plus valid `structuredContent`.
- **MCP-3** `run_flow` returns in under 500 ms for the `foreach-100k` fixture against a fake or real service.
- **MCP-4** Every `ServiceError` code produces `isError: true` with the same `code`; an unexpected exception becomes `E_INTERNAL`, and the server keeps serving.
- **MCP-5** `wait_for_run` returns `done: true` as soon as the run is terminal, and `done: false` at the timeout (fake timers); `timeoutMs` is clamped to 30 s.
- **MCP-6** Passing both or neither of `flow` / `flowName` is rejected with `E_BAD_REQUEST`.
- **MCP-7** Over stdio, stdout contains only valid JSON-RPC lines even when a handler calls `console.log` or throws (e2e).
- **MCP-8** `inspect_run` on a 10k-node fixture stays under 64 KB and says it truncated.
- **MCP-9** `open_gui` spawns the injected argv detached, passes `runId` and `--no-terminal` correctly, and is absent when `openCommand` is undefined.
- **MCP-10** Closing stdin ends the process with exit code 0 and releases the database connection.

## Open Questions

MCP resources (a run as a readable resource) and prompts are not in Phase 1.
