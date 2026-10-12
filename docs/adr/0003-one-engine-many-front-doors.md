# 0003. One engine, many front doors, Postgres as the bus

## Context
Loopwork must be usable from a terminal, from Claude Code as `/loopwork`
(opening a terminal window and a GUI window), and from Claude Desktop. Claude
Desktop chat only talks to external tools through MCP. Claude Code slash
commands can only run prompts and shell commands. The plan's wedge is "the
canvas is the runtime", so a visual window cannot wait for Phase 2 entirely.

## Decision
- All behaviour lives in `run-service`, a programmatic API over the engine.
- Thin front doors call it: the `loopwork` CLI, a stdio MCP server
  (`loopwork mcp`), a local GUI (`ui-server` + `ui-viewer`), and a Claude Code
  plugin whose `/loopwork` command runs `loopwork open`. That launches a new
  terminal window and a GUI window via `window-launcher`.
- The GUI is a local web app (React + React Flow) served by `node:http` on
  `127.0.0.1` with a per-launch token, shown in a chromeless app-mode browser
  window. Interactive in Phase 1 (start, resume, cancel via a token + cookie +
  Host/Origin/CSRF-protected write API); graph editing arrives in Phase 2 as the editable canvas.
- Front doors share state only through the Postgres event log (ADR 0002).
  Starting a run enqueues a job and returns its id. Workers run detached, so
  an MCP call never blocks and a terminal or GUI can attach to any run later.
- Claude Desktop chat is supported through MCP, packaged as an `.mcpb` bundle
  with a `claude_desktop_config.json` fallback.

## Consequences
- The CLI, MCP and GUI surfaces cannot drift: all are views over `run-service`.
- Runs survive closing the terminal, the GUI or Desktop, because workers are detached and durable.
- Adds `@modelcontextprotocol/sdk`; React, React Flow and Vite were already planned.
- Pulls an interactive viewer into Phase 1; Phase 2 becomes "make the graph editable".
- A write-capable localhost service needs explicit defences (loopback bind, per-launch token, Host and Origin checks); see `SPEC-ui-server.md`.
- No Electron or Tauri to package. The cost is that the window is a browser
  window: it needs Chrome or Edge for the chromeless look, else a normal tab.
- Postgres becomes a prerequisite for every user, so `doctor` and `init` need
  to make local setup painless.
- Opening windows is platform-specific and untestable in CI. It has printable
  fallbacks and a manual checklist in `exit-gate`.
- The WSL2/Windows boundary is unresolved (see CAPABILITY-MAP open questions).
