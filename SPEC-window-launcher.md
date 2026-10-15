# Spec: window-launcher (`@loopwork/windows`)

Depends on: none. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

Open a new **terminal window** running a command, and a new **app window** showing a URL, on WSL2, macOS and
Linux (native Windows is best-effort). It knows nothing about Loopwork. It must never fail silently: if no
window can be opened it says so and returns a command the user can paste.

## Tech Stack

TypeScript, `node:child_process`, `node:fs`, `node:os`. No dependencies.

## Commands

```
pnpm --filter @loopwork/windows test
```

## Project Structure

```
packages/windows/
  src/platform.ts     detectPlatform(env, fs): 'wsl' | 'darwin' | 'linux' | 'win32'
  src/plan.ts         planTerminal(req, env), planAppWindow(url, env): LaunchPlan   (pure)
  src/execute.ts      openTerminal, openAppWindow: plan -> spawn -> LaunchResult
  src/quote.ts        shell quoting per target (posix sh, cmd.exe)
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
openTerminal(req, env?): Promise<LaunchResult>
openAppWindow(url, env?): Promise<LaunchResult>
type LaunchEnv = { platform: Platform; env: Record<string,string|undefined>; exists(path: string): boolean; which(cmd: string): string | undefined };
```

### Strategy per platform (in order; first available wins)

| Platform | Terminal | App window |
|---|---|---|
| `wsl` | `wt.exe -w new --title T wsl.exe --cd <cwd> --exec <argv...>`; else `cmd.exe /c start wsl.exe ...` (`--exec`, not `--`: `--` hands the rest of the line to the distro's default shell, which would re-parse `argv`; `--exec` skips the shell. To be confirmed on a real WSL host: manual exit-gate checklist) | Chrome/Edge `--app=<url>` via `/mnt/c/Program Files*/…/chrome.exe` or `msedge.exe`; else `wslview <url>`; else `cmd.exe /c start "" <url>` |
| `darwin` | `osascript` to open Terminal (or iTerm if `TERM_PROGRAM=iTerm.app`) running the command | `open -na "Google Chrome" --args --app=<url>`, else Edge, else `open <url>` |
| `linux` | `$LOOPWORK_TERMINAL` prefix, else `x-terminal-emulator -e`, `gnome-terminal --`, `kitty`, `konsole -e`, `xterm -e` (requires `DISPLAY` or `WAYLAND_DISPLAY`) | `google-chrome`/`chromium`/`microsoft-edge` with `--app=<url>`, else `xdg-open <url>` |
| `win32` | `wt.exe`, else `cmd.exe /c start` | Chrome/Edge `--app`, else `cmd.exe /c start "" <url>` |

`LOOPWORK_TERMINAL` (env): a command prefix that overrides terminal discovery on every platform, e.g. `alacritty -e`.

`keepOpen` wraps the command so the window stays after it exits: `sh -c '<cmd>; printf "\n[loopwork exited — press Enter to close]"; read _'` (POSIX), equivalent `cmd /k` on Windows.

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
- **WL-2** With no display on Linux (no `DISPLAY`/`WAYLAND_DISPLAY`), `openTerminal` returns `unsupported` whose `fallback` is the original command line, correctly quoted.
- **WL-3** `quote.ts` round-trips a corpus of hostile strings through `sh -c 'printf %s "$1"' _ <quoted>` unchanged (real `sh`, Linux/macOS CI), and the `cmd.exe` quoter has a unit-tested expectation table.
- **WL-4** `openAppWindow` rejects non-local URLs, URLs with spaces/`"`/`;`/`|`/backticks, and `file:`/`javascript:` schemes.
- **WL-5** On `wsl`, the Chrome/Edge lookup finds the executable under both `Program Files` and `Program Files (x86)`; with neither it falls back to `wslview`, then `cmd.exe start`.
- **WL-6** `keepOpen: true` (default) wraps the command; `false` does not.
- **WL-7** `LOOPWORK_TERMINAL` overrides discovery and is split on whitespace into argv (no shell).
- **WL-8** A failed first step falls through to the next; if all fail the result is `unsupported` with the failure reasons in `reason`.

## Open Questions

None blocking. Native Windows (`win32`) is implemented from the table but untested outside the planner unit tests.
