# Spec: cli (`apps/cli`, binary `loopwork`)

Depends on: `run-service`, `window-launcher`, `ui-server` (and starts `mcp-server` for `loopwork mcp`). Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The `loopwork` command: a thin shell over `run-service`, plus the glue that opens windows. Output for humans by
default, `--json` for machines. **Exit codes and `--json` shapes are a public contract.**

## Tech Stack

TypeScript, `node:util` `parseArgs` (no arg-parsing library), `node:child_process`. Published bin: `loopwork` (`#!/usr/bin/env node`).

## Commands (the tool's own surface)

```
loopwork validate <flow.json>
loopwork run <flow.json> [--input <file>|-] [--follow] [--json]
loopwork resume <runId> [--follow]
loopwork cancel <runId>
loopwork inspect <runId> [--json]
loopwork list [--status s] [--limit n] [--json]
loopwork follow <runId> [--json]
loopwork doctor [--json]
loopwork init [--dir <path>] [--force]
loopwork worker [--idle-exit <ms>]                 # internal: foreground worker
loopwork ui [--port n] [--no-open] [--print-url] [--idle-timeout <ms>]
loopwork mcp                                       # stdio MCP server
loopwork install claude-code|desktop [--user-command] [--plugin] [--wsl] [--write] [--uninstall]
loopwork open [<runId> | <flow.json>] [--no-terminal] [--no-gui]
loopwork --version | --help
```

Dev commands for this module: `pnpm --filter loopwork build`, `pnpm --filter loopwork test`, `pnpm --filter loopwork test:e2e`.

## Project Structure

```
apps/cli/
  bin/loopwork.js          shebang entry
  src/main.ts              dispatch, global error → exit code mapping
  src/commands/*.ts        one file per command
  src/output.ts            human + --json writers (stdout), logger (stderr)
  src/exit.ts              ExitCode table, mapServiceError
  src/open.ts              open orchestration
  src/init.ts              templates
  templates/               docker-compose.yml, loopwork.config.json, sample flows
  test/
```

## Behaviour

**Streams.** Data goes to **stdout**; progress, hints and errors to **stderr**. `loopwork mcp` writes **nothing** to stdout but protocol frames.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | success (for `run --follow`/`follow`/`resume --follow`: the run `succeeded`) |
| 1 | internal error |
| 2 | usage error, invalid flow, bad input (`E_VALIDATION`, `E_BAD_REQUEST`, `E_UNKNOWN_FN`) |
| 3 | configuration or database problem (`E_CONFIG`, `E_DB_UNREACHABLE`); `doctor` with failing checks |
| 4 | not found (`E_NOT_FOUND`) |
| 5 | run ended `failed` (`--follow` modes) |
| 6 | run ended `cancelled` (`--follow` modes) |
| 7 | state conflict (`E_NOT_RESUMABLE`, `E_NOT_CANCELLABLE`) |

**`run`** validates, starts, prints the run id (`--json`: `{"runId":"…"}`) and returns immediately; with `--follow` it then streams. Without
`--follow` the run continues detached. `--input -` reads JSON from stdin.

**`--follow` output (human).** A line per notable event, plus a status line refreshed every second when stdout is a TTY: elapsed time, items/s, per-frame
`iteration n/limit`, in-flight count, recent errors. When not a TTY: one line per 2 s. `--json` emits NDJSON of coalesced `RunView`s.
**Ctrl-C detaches, it does not cancel** ("run continues: loopwork follow <id>"); exit code 130.

**`init`** writes, without overwriting existing files unless `--force`: `docker-compose.yml` (Postgres 16 on port 5432, named volume, password from an
`.env` file it also creates, mode 0600, git-ignored), `loopwork.config.json`, `flows/hello.flow.json`, `flows/loop-demo.flow.json`, and prints the next three commands.

**`install` and extra `doctor` checks** are provided by `@loopwork/claude-integration`, loaded with a **dynamic `import()`** so the cli has no static dependency on it (it depends on the cli, not the reverse). If the module is absent, `install` exits 2 with a hint and `doctor` simply omits those checks. The module exports `install(target, opts)` and `checks(): DoctorCheck[]`; `doctor` merges them into the `run-service` report.

**`ui`** starts `ui-server` with `staticDir` resolved from `$LOOPWORK_VIEWER_DIR`, else `<cli package>/viewer` if present, else none (API only, with a stderr notice and a `doctor` warning). `--print-url` writes a single JSON line `{"url": "…"}` to stdout, then keeps running
and **ignores `EPIPE` on stdout** (the launching parent closes the pipe). Without `--no-open` it opens the app window itself.

**`open`** (what `/loopwork` runs):
1. Resolve the target: `<runId>` (must exist), `<flow.json>` (start it first via `startRun`, print the run id), or nothing (list view).
2. Unless `--no-gui`: spawn `loopwork ui --no-open --print-url --idle-timeout 30m` detached with stdout piped, read the first JSON line (10 s timeout), then detach; `window-launcher.openAppWindow(url + '#/runs/<id>')`.
3. Unless `--no-terminal`: `openTerminal({ argv: [process.execPath, bin, 'follow', id] , keepOpen: true })`, or `list` when no run is targeted.
4. Print one summary line per window: `launched` or the `unsupported` fallback command. `open` exits 0 when at least one requested window launched **or** a fallback was printed; the run id is always printed.

The `worker` command is what `ensureWorker` spawns; the cli passes `[process.execPath, <this bin>, 'worker', '--idle-exit', '600000']`.

## Code Style

```ts
export async function cancel(argv: string[], ctx: Ctx): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const [runId] = positionals;
  if (!runId) return usage(ctx, 'cancel <runId>');
  const r = await ctx.service.cancelRun(runId);
  ctx.out.line(`${r.runId}: ${r.state}`, r);
  return ExitCode.Ok;
}
```
Commands return an exit code; only `main.ts` calls `process.exit`.

## Testing Strategy

Command-level unit tests call `main(argv, ctx)` with a fake `Service`, captured stdout/stderr and a fake window launcher; they assert output and exit code.
`*.e2e.test.ts` spawns the real binary against Postgres: `init` in a temp dir, `run --follow` a small flow, `open --no-gui --no-terminal` plumbing with a fake
`LOOPWORK_TERMINAL` that writes its argv to a file.

## Boundaries

- Always: stdout for data only; one exit code per documented meaning; redact the DB password everywhere; leave the run running on Ctrl-C.
- Ask first: new commands or flags that change an existing one; changing an exit code.
- Never: import `pg`, `@loopwork/engine` or `@loopwork/runtime` directly; call `process.exit` outside `main.ts`; print the GUI token anywhere but the `--print-url` line; overwrite files in `init` without `--force`.

## Success Criteria

- **CLI-1** Each error code of the exit-code table is produced by the documented cause (table-driven test through `main`).
- **CLI-2** `validate` on every graph-model error fixture exits 2 and lists every error with its code and `path`; on valid fixtures exits 0.
- **CLI-3** `run` returns the run id and exit 0 without waiting; `run --follow` exits 0/5/6 matching the final status.
- **CLI-4** `--json` output is parseable (single JSON object, or NDJSON for `follow`) and has no human text on stdout (snapshot of key shapes).
- **CLI-5** Ctrl-C (SIGINT) during `--follow` exits 130, the run keeps running (assert via `inspect`), and the message names the `follow` command.
- **CLI-6** `loopwork mcp` writes only JSON-RPC to stdout (shared check with MCP-7).
- **CLI-7** `init` in an empty directory creates the files, `docker compose config` accepts the compose file, `loopwork validate flows/*.flow.json` passes, and `.env` is mode 0600; running it again without `--force` changes nothing and exits 0 with a notice.
- **CLI-8** `ui --print-url` prints exactly one JSON line first; the server keeps running after the reader closes the pipe.
- **CLI-9** `open <flow.json>` starts the run, starts the UI, and calls the window launcher with a URL ending `#/runs/<id>` and a terminal argv `follow <id>`; with `--no-gui`/`--no-terminal` each is skipped.
- **CLI-10** With no display or terminal available, `open` prints fallback commands, still prints the run id, and exits 0.
- **CLI-11** `doctor` exits 3 when any check fails, and every failed check prints its `fix`.
- **CLI-12** `--version` and `--help` work without any config or database present.
- **CLI-13** With `@loopwork/claude-integration` absent, `install` exits 2 with a hint and `doctor` still works; with it present, its checks appear in the merged report.

## Open Questions

Shell completions are not in Phase 1.
