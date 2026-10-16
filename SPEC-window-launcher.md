# Spec: window-launcher (`@loopwork/windows`)

Depends on: none. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Open a new **terminal window** running a command, and a new **app window** showing a URL, on WSL2, macOS and
Linux (native Windows is best-effort). It knows nothing about Loopwork. It must never fail silently: if no
window can be opened it says so and returns a command the user can paste.

## Tech Stack

TypeScript, `node:child_process`, `node:fs`, `node:path`. No dependencies.

## Commands

```
pnpm --filter @loopwork/windows test
```

## Project Structure

```
packages/windows/
  src/platform.ts     detectPlatform(env, fs, platform = process.platform): 'wsl' | 'darwin' | 'linux' | 'win32'
  src/plan.ts         re-exports planTerminal, planAppWindow
  src/plan-terminal.ts      planTerminal(req, env): LaunchPlan | undefined   (pure)
  src/plan-app-window.ts    planAppWindow(url, env): LaunchPlan | undefined  (pure)
  src/execute.ts      openTerminal, openAppWindow: plan -> spawn -> LaunchResult; defaultLaunchEnv (real env; not exported from the index)
  src/quote.ts        shell quoting per target (posix sh, cmd.exe)
  src/index.ts        exports openTerminal, openAppWindow, detectPlatform, planTerminal, planAppWindow and the types LaunchEnv, LaunchPlan, LaunchResult, Platform, TerminalRequest
  test/fixtures/      env snapshots per platform
```

## Contract

```ts
type TerminalRequest = { argv: string[]; cwd?: string; title?: string; keepOpen?: boolean /* default true */ };
type LaunchPlan = { steps: { command: string; args: string[] }[]; describe: string };   // first step that spawns successfully wins
type LaunchResult =
  | { status: 'launched'; via: string }
  | { status: 'unsupported'; reason: string; fallback: string };   // fallback = a pasteable command / the URL

planTerminal(req: TerminalRequest, env: LaunchEnv): LaunchPlan | undefined
planAppWindow(url: string, env: LaunchEnv): LaunchPlan | undefined
openTerminal(req, env?, deps?: { spawn?: typeof child_process.spawn }): Promise<LaunchResult>   // env defaults to the real environment; deps.spawn is the test seam
openAppWindow(url, env?, deps?): Promise<LaunchResult>
type LaunchEnv = { platform: Platform; env: Record<string,string|undefined>; exists(path: string): boolean; which(cmd: string): string | undefined };
```

### Strategy per platform (in order; first available wins)

| Platform | Terminal | App window |
|---|---|---|
| `wsl` | `wt.exe -w new --title T wsl.exe --cd <cwd> --exec <argv...>`; else `cmd.exe /c start wsl.exe ...` (`--exec`, not `--`: `--` hands the rest of the line to the distro's default shell, which would re-parse `argv`; `--exec` skips the shell. To be confirmed on a real WSL host: manual exit-gate checklist). Both steps need `wsl.exe` on `PATH`, and each step needs its own program (`wt.exe`, `cmd.exe`) found by `which` | Chrome/Edge `--app=<url>` via `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`, then `/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe`, then `msedge.exe` under `Microsoft/Edge/Application/` in the same two roots (every one that exists is a step); else `wslview <url>`; else `cmd.exe /c start "" <url>` |
| `darwin` | `osascript` to open Terminal (or iTerm if `TERM_PROGRAM=iTerm.app`) running the command | `open -na "Google Chrome" --args --app=<url>`, else Edge, else `open <url>` |
| `linux` | `$LOOPWORK_TERMINAL` prefix, else `x-terminal-emulator -e`, `gnome-terminal --`, `kitty`, `konsole -e`, `xterm -e` (requires `DISPLAY` or `WAYLAND_DISPLAY`) | `google-chrome`/`chromium`/`microsoft-edge` with `--app=<url>`, else `xdg-open <url>` |
| `win32` | `wt.exe -w new --title T [-d <cwd>] cmd.exe /d /s /k <line>`, else `cmd.exe /c start [/D <cwd>] cmd.exe /d /s /k <line>` (no `start` window title is passed) | Chrome/Edge `--app` under `%ProgramFiles%` then `%ProgramFiles(x86)%` (defaults `C:\Program Files`, `C:\Program Files (x86)`), else `cmd.exe /c start "" <url>` |

On `darwin` the terminal strategy is the single `osascript` step. On `darwin` the app window tries each installed app under `/Applications/` (`Google Chrome`, then `Microsoft Edge`) as `open -na <app> --args --app=<url>`, then `open <url>`; on `linux` every installed browser (`google-chrome`, `chromium`, `microsoft-edge`) is a step before `xdg-open <url>`. A step whose program is not found by `which` is dropped; if no step remains the planner returns `undefined`.

`LOOPWORK_TERMINAL` (env): a command prefix that overrides terminal discovery on every platform, e.g. `alacritty -e`. It is split on whitespace and yields exactly one step: `<prefix...> <payload>`, where the payload is built as for the POSIX terminals (`sh -c '<line>'`, or the bare `argv` when `keepOpen` is false and no `cwd` has to be applied inline). The prefix program is not checked with `which` and the Linux display requirement does not apply (the override wins). On `win32` the payload is still the `sh -c` form; native Windows has no `sh`, so there the override is only useful with a prefix that supplies one.

`keepOpen` wraps the command so the window stays after it exits; the exact shapes are:

- POSIX terminals (linux; `LOOPWORK_TERMINAL`): `sh -c '<cd -- <cwd> && ><joinPosix(argv)>; printf "\n[loopwork exited — press Enter to close]"; read _'`, passed as the argv array `['sh', '-c', line]`, never pasted inside a hand-written quoted string. Terminals without a cwd flag get the inline `cd -- <cwd> &&` prefix. With `keepOpen: false` and no `cwd` there is no shell at all: the payload is `argv` itself; with `keepOpen: false` and a `cwd`, it is `sh -c 'cd -- <cwd> && <argv>'`.
- `wsl`: `wsl.exe [--cd <cwd>] --exec sh -c '<joinPosix(argv)>; printf ...; read _'` (cwd is applied by `--cd`, so no inline `cd`); with `keepOpen: false` it is `wsl.exe [--cd <cwd>] --exec <argv...>`.
- `win32`: `cmd.exe /d /s /k <joinCmd(argv)>` (`/c` when `keepOpen` is false); there is no banner. The cwd is applied by `wt.exe -d` or `start /D`.
- `darwin`: an AppleScript string literal (only `\` and `"` escaped) holding the POSIX `line` including the inline `cd`: `tell application "Terminal" to do script "<line>"`, or `tell application "iTerm" to create window with default profile command "<line>"` when `TERM_PROGRAM=iTerm.app`.

## Quoting

`quotePosix` wraps in single quotes and rewrites each embedded `'` as `'\''`. `quoteCmd` is a two-stage scheme:

1. argv quoting (CommandLineToArgvW rules): an empty string, or one containing a space, tab or `"`, is wrapped in `"..."`; backslashes before a `"` are doubled and the `"` becomes `\"`; backslashes before the closing quote are doubled; anything else is left bare.
2. caret-escape: every `( ) % ! ^ " < > & |` in the result is prefixed with `^`, including inside quotes (cmd.exe's quote state is not reliable across the layers).

A CR or LF cannot ride in one cmd command line and is flattened to a space. Known limits: `^%` relies on no variable name ending in `^` existing; `^!` does not stop `!VAR!` expansion under `/V:ON` (value substitution only, no command injection).

Callers of cmd.exe spell out the layers per case:

- the `win32` `wt.exe` step and the `wsl` `wt.exe` step pass `joinCmd(argv)` / the `wsl.exe` args as ordinary argv, with every `;` in every argument escaped as `\;` (wt.exe treats a bare `;` as a sub-command separator);
- the `wsl` `cmd.exe /c start wsl.exe ...` step quotes every `wsl.exe` argument with `quoteCmd` (both stages);
- the `win32` `cmd.exe /c start ...` step is double-parsed: the outer `cmd.exe /c` strips one caret layer, then the started `cmd.exe` reads the line itself (no argv parsing), so the tokens (`/D <cwd>`, `cmd.exe /d /s /k`, and the already-`joinCmd`ed line) get a second, caret-only escape (`caretOnly`) and are not argv-quoted again; a `cwd` containing whitespace is wrapped in `"..."` before the caret layer;
- `start "" <url>` for app windows: the empty title token and the URL are caret-escaped (`^"^"`).

## Execution and fallback strings

`openTerminal` / `openAppWindow` try the plan's steps in order. Each step is spawned with `detached: true`, `stdio: 'ignore'`, `windowsHide: false`, plus `windowsVerbatimArguments: true` **only** when the command's basename is `cmd.exe` (compared case-insensitively; planners emit the bare name `cmd.exe`): its args are pre-escaped command-line text and libuv must not re-quote them (re-quoting `"` as `\"` would break the caret layering). `wt.exe` and other steps are spawned normally. A step has launched when the child emits `spawn` (the child is then `unref`'d and the result is `{ status: 'launched', via: <command> }`); a spawn error event or a synchronous throw moves on to the next step.

When nothing launched, the result is `{ status: 'unsupported', reason, fallback }`:

- `reason`: the failures joined as `<command>: <message>; <command>: <message>`; with no steps at all, `no terminal strategy available on <platform>` or `no app-window strategy available for <url> on <platform>` (also the reason for a URL that fails the local-URL check).
- `fallback` for a terminal: the original command line quoted for the platform's shell, with the cwd as a prefix when given: `cd -- <quotePosix(cwd)> && <joinPosix(argv)>` on `wsl`, `darwin` and `linux`; `cd /d <cwd, caret-escaped, double-quoted if it has whitespace> && <joinCmd(argv)>` on `win32`. It never includes the `keepOpen` wrapper.
- `fallback` for an app window: the URL, verbatim.

## Security

- `argv` is passed as an **array** to `spawn`; it is shell-quoted only where a shell is unavoidable (`sh -c`, `cmd.exe /c`) via `quote.ts`, with tests for quotes, spaces, `$`, backticks, `;`, `&`, `%`, newlines.
- `openAppWindow` only accepts URLs matching `^https?://(127\.0\.0\.1|localhost)(:\d+)?(/[A-Za-z0-9._~:/?=#&%-]*)?$`. Anything else returns `unsupported`. This is also what keeps `cmd.exe start` safe.
- No window is opened with elevated privileges; nothing is written to disk.

## Code Style

```ts
export function planAppWindow(url: string, e: LaunchEnv): LaunchPlan | undefined {
  if (!LOCAL_URL.test(url)) return undefined;
  const chromium = findChromium(e);              // returns absolute path or undefined
  return chromium ? plan(`${chromium} --app=${url}`, [{ command: chromium, args: [`--app=${url}`] }]) : fallbackOpen(e, url);
}
```
Plans are pure data so every platform's behavior is testable on any machine.

## Testing Strategy

Unit tests on the pure planners using env fixtures for WSL2 (with and without `wt.exe`), macOS, Linux (with/without
display, with `LOOPWORK_TERMINAL`), Windows. `execute.ts` is tested with an injected fake `spawn` (success, ENOENT
then second step succeeds, all fail). Real windows are covered by the manual checklist in `SPEC-exit-gate.md`.

## Boundaries

- Always: return `unsupported` with a `fallback` rather than throwing; spawn detached with `stdio: 'ignore'` and `unref()` so the launching process can exit.
- Ask first: adding a terminal emulator to the list; any behavior that needs the clipboard or elevated rights.
- Never: build a command line by string concatenation of user input; execute through `sh -c` when an argv spawn would do; import another `@loopwork/*` package.

## Success Criteria

- **WL-1** For each platform fixture, `planTerminal` yields the documented first-choice command; removing that tool from `which` yields the next choice.
- **WL-2** With no display on Linux (no `DISPLAY`/`WAYLAND_DISPLAY`), `openTerminal` returns `unsupported` whose `fallback` is the original command line, correctly quoted (with a `cd -- <cwd> && ` prefix when a `cwd` was given).
- **WL-3** `quote.ts` round-trips a corpus of hostile strings through `sh -c 'printf %s "$1"' _ <quoted>` unchanged (real `sh`, Linux/macOS CI), and the `cmd.exe` quoter has a unit-tested expectation table.
- **WL-4** `openAppWindow` rejects non-local URLs, URLs with spaces/`"`/`;`/`|`/backticks, and `file:`/`javascript:` schemes.
- **WL-5** On `wsl`, the Chrome/Edge lookup finds the executable under both `Program Files` and `Program Files (x86)`; with neither it falls back to `wslview`, then `cmd.exe start`.
- **WL-6** `keepOpen: true` (default) wraps the command; `false` does not.
- **WL-7** `LOOPWORK_TERMINAL` overrides discovery and is split on whitespace into argv (no shell).
- **WL-8** A failed first step falls through to the next; if all fail the result is `unsupported` with the failure reasons in `reason`.

## Open Questions

None blocking. Native Windows (`win32`) is implemented from the table but untested outside the planner unit tests.

Verified only by model / needs a real host (none of this can run in Linux CI; a `windows-latest` job and a real-WSL smoke test are Phase 2; see the manual checklist in `SPEC-exit-gate.md`):

- `quoteCmd` is verified against an independent model of cmd.exe plus CommandLineToArgvW, not a real `cmd.exe`.
- `wsl.exe --cd <cwd> --exec sh -c <line>` really skips the distro's shell, via `wt.exe` and via `cmd.exe /c start`, and the `keepOpen` banner and inner `"` survive `wt.exe` re-joining its arguments.
- `wt.exe`'s `\;` escaping behaves as described, and WSL interop does not re-quote `cmd.exe` arguments (the `windowsVerbatimArguments` handling is asserted only as a spawn option on a fake `spawn`).
- The `win32` `cmd.exe /c start cmd.exe /d /s /k <line>` fallback handles arguments with spaces and `& | < > ( )` correctly (the double-parse above).
- macOS: the `osascript` Terminal and iTerm scripts.

Known gaps: on `win32`, an empty-string `cwd` yields an empty `/D` token; the fallback passes no `start` title; the `—` in the `keepOpen` banner may mis-display under some cmd.exe code pages; the `wsl` Chrome/Edge lookup is hard-wired to `/mnt/c`; on `win32` the same path appears twice when `%ProgramFiles%` equals `%ProgramFiles(x86)%`, and an empty `%ProgramFiles%` is not treated as unset.
