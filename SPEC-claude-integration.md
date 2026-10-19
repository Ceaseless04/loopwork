# Spec: claude-integration (`integrations/claude`)

Depends on: `cli`, `mcp-server`, `ui-viewer`. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Make Loopwork one step away from Claude: typing **`/loopwork`** in Claude Code (terminal CLI, and the Code tab of
Claude Desktop) opens a terminal window and a GUI window; Claude Desktop chat can run flows through MCP. This module
is packaging and glue, with no logic of its own beyond install and doctor checks.

> **Verify before building.** Claude Code's plugin layout, slash-command namespacing, `.mcp.json`, and the Claude Desktop
> `.mcpb` manifest are external, evolving formats. The implementer must read the **current** official docs
> (`claude-code-guide` agent for Claude Code; the MCPB repository README for the bundle) and record the exact manifest
> versions used in `integrations/claude/README.md`. The file shapes below are the intent, not a substitute for that check.

## Tech Stack

Markdown + JSON artifacts, a small Node build script (no bundler dependency by default: the CLI is already a compiled ESM package). `.mcpb` is produced with Anthropic's MCPB packer as a **dev tool** (new dev dependency, flagged for approval).

## Commands

```
pnpm --filter claude-integration build         # assembles dist/{plugin,desktop} and copies ui-viewer assets
pnpm --filter claude-integration pack:mcpb     # dist/loopwork.mcpb  (needs the MCPB packer)
pnpm --filter claude-integration test
loopwork install claude-code [--user-command] [--plugin]      # implemented in cli, driven by this module's files
loopwork install desktop [--wsl]                                # prints/merges the config snippet; --write to modify the file
loopwork doctor                                                 # includes the claude-integration checks below
```

## Project Structure

```
integrations/claude/
  plugin/
    .claude-plugin/plugin.json          name: "loopwork"
    commands/loopwork.md                the /loopwork command
    .mcp.json                           registers `loopwork mcp` for Claude Code
  user-command/loopwork.md              same command as a plain ~/.claude/commands file (guarantees the bare `/loopwork` name)
  desktop/
    manifest.json                       MCPB manifest (server: node, entry points at the bundled cli)
    claude_desktop_config.example.json  native + WSL variants
  scripts/build.ts, scripts/pack-mcpb.ts
  README.md                             install steps, manifest versions, troubleshooting
  test/
```

## The `/loopwork` command

```markdown
---
description: Open Loopwork — a terminal window and a GUI window (optionally for a run or flow file)
argument-hint: [runId | flow.json] [--no-terminal] [--no-gui]
allowed-tools: Bash(loopwork open:*)
---
Run exactly: `loopwork open $ARGUMENTS`
Then reply in one or two lines: the run id (if any), which windows opened, and, if the command printed a
fallback command or URL because a window could not open, show it verbatim in a code block.
Do not inspect, summarise or modify any files. If `loopwork` is not found, say to run `loopwork doctor` after installing.
```

- `$ARGUMENTS` is passed through unmodified to `loopwork open`, which does its own validation (the command never builds shell strings itself; `allowed-tools` restricts Bash to this prefix).
- Windows/WSL: Claude Code runs inside WSL2 here, so `loopwork open` runs there and `window-launcher` reaches Windows Terminal and the browser through `wt.exe` and interop.
- Plugin commands can appear namespaced (`/loopwork:loopwork`); the `user-command` file exists so the **bare** `/loopwork` always works. `loopwork install claude-code` installs the user-command by default, and the plugin (for MCP registration) with `--plugin`.

## Claude Desktop

- **MCPB bundle (`loopwork.mcpb`)**: manifest declares one `node` server running the bundled `loopwork mcp`, with `user_config` fields `databaseUrl` (sensitive) and `flowsDir`. The bundle includes the compiled CLI and `viewer/` assets.
- **Config snippet** (fallback; the exact file path is `claude_desktop_config.json` under Claude Desktop's config dir): native `{ "command": "loopwork", "args": ["mcp"], "env": { "DATABASE_URL": "…" } }`, and the **WSL variant** `{ "command": "wsl.exe", "args": ["-e", "loopwork", "mcp"] }` for Desktop on Windows with Loopwork in WSL2. The DB password is never written by default; the user supplies it or points at `loopwork.config.json`.
- `open_gui` in MCP launches windows on the **machine where the MCP server runs**; in the WSL variant that is WSL2, which can reach Windows Terminal and the browser.

## Package surface

`@loopwork/claude-integration` exports `install(target: 'claude-code' | 'desktop', opts): Promise<InstallReport>` and `checks(): DoctorCheck[]`. The cli loads it dynamically (`SPEC-cli.md`); this package imports **types only** from the cli's public contract, never its code.

## Doctor checks contributed (via `checks()`)

`claude-code-command` (user-command file present and equal to the shipped one), `claude-plugin` (informational), `desktop-config` (snippet present, informational), `mcp-handshake` (spawn `loopwork mcp`, do `initialize` + `tools/list`, expect the documented tools), `viewer-assets` (viewer `index.html` found), `windows` (a terminal/app launcher plan exists for this environment).

## Code Style

```ts
// scripts/build.ts: copy, don't generate. Keep the shipped files human-reviewable.
await cp('plugin', 'dist/plugin', { recursive: true });
await cp(viewerDist, 'dist/viewer', { recursive: true });
await assertNoSecrets('dist');           // fail the build if anything resembles a credential
```

## Testing Strategy

Unit/snapshot tests of the shipped files: front-matter parses, `allowed-tools` is exactly the restricted prefix, the command text contains
`loopwork open $ARGUMENTS`, manifests parse, JSON snippets validate, no secret-like strings. An `*.e2e.test.ts` runs `loopwork install claude-code`
into a temp `HOME`, checks the file, and performs the MCP handshake. Real Claude Code and Claude Desktop installs are in the manual checklist (`SPEC-exit-gate.md`).

## Boundaries

- Always: keep the shipped command minimal and non-agentic; restrict `allowed-tools`; document manifest versions; make installs idempotent and reversible (`loopwork install … --uninstall`).
- Ask first: the MCPB packer dev dependency; any change that writes outside `~/.claude/` and the Claude Desktop config; adding more slash commands.
- Never: write or ship a `DATABASE_URL`/password; auto-edit `claude_desktop_config.json` without `--write` and a backup (`.bak`); let the command run arbitrary Bash; claim Desktop support for a configuration that wasn't tested (the README states what was).

## Success Criteria

- **CI-1** The shipped `/loopwork` command parses, restricts Bash to `loopwork open:*`, and passes `$ARGUMENTS` through to `loopwork open` only.
- **CI-2** `loopwork install claude-code` creates `~/.claude/commands/loopwork.md` identical to the shipped file, is idempotent, backs up a differing existing file, and `--uninstall` removes it.
- **CI-3** The plugin directory has a valid manifest and `.mcp.json` that launch `loopwork mcp`; structure matches the verified current docs (README records the version checked).
- **CI-4** `loopwork mcp` launched exactly as the `.mcp.json` / MCPB manifest / config snippet specify completes `initialize` and `tools/list` (handshake test for each launch form; the WSL form is verified manually).
- **CI-5** `desktop/manifest.json` validates against the MCPB schema; `pack:mcpb` produces a bundle containing the CLI and `viewer/`; the bundle contains no secrets.
- **CI-6** `loopwork install desktop` prints the native and WSL snippets; `--write` makes a `.bak` of the existing config, merges rather than overwrites other servers, and refuses invalid JSON.
- **CI-7** `doctor` reports each integration check with a `fix` hint on failure; `mcp-handshake` fails clearly if the binary is not on `PATH`.
- **CI-8** (manual) In Claude Code CLI, typing `/loopwork` opens both windows; with a flow path it starts the run and the GUI shows it; in Desktop's Code tab the same.
- **CI-9** (manual) In Claude Desktop chat, "run the loop-demo flow" results in `run_flow` then `inspect_run`/`wait_for_run`, and the run is visible live in a `loopwork open` GUI window.

## Open Questions

1. Exact slash-command namespacing for plugins and the current MCPB manifest version must be verified at implementation time (see the note at the top).
2. Whether Claude Desktop on Windows launching a `wsl.exe -e loopwork mcp` server needs a login-shell `PATH` (`wsl.exe -e bash -lc "loopwork mcp"`). Verify on the target machine; document the working form.
