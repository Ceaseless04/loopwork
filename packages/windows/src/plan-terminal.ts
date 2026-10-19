import { joinCmd, joinPosix, quoteCmd, quotePosix } from './quote.js';
import type { LaunchEnv, LaunchPlan, Platform, TerminalRequest } from './types.js';

const KEEP_TAIL = '; printf "\\n[loopwork exited — press Enter to close]"; read _';
// wt.exe treats a bare `;` in any argument as a sub-command separator.
const wtEscape = (s: string): string => s.replaceAll(';', '\\;');
// AppleScript string literals only need `\` and `"` escaped.
const appleEscape = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
export const caretOnly = (s: string): string => s.replace(/[()%!^"<>&|]/g, '^$&');
const LINUX_TERMINALS: [string, string[]][] = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['kitty', []],
  ['konsole', ['-e']],
  ['xterm', ['-e']],
];

export function planTerminal(req: TerminalRequest, env: LaunchEnv): LaunchPlan | undefined {
  const { argv, cwd, title = 'loopwork', keepOpen = true } = req;
  const has = (cmd: string): boolean => env.which(cmd) !== undefined;

  // POSIX payload. Targets without a cwd flag get a `cd` prefix (cdInline); no shell unless one is needed.
  const line = (cdInline: boolean): string =>
    (cdInline && cwd !== undefined ? `cd -- ${quotePosix(cwd)} && ` : '') + joinPosix(argv) + (keepOpen ? KEEP_TAIL : '');
  const payload = (cdInline: boolean): string[] =>
    keepOpen || (cdInline && cwd !== undefined) ? ['sh', '-c', line(cdInline)] : argv;
  const cmdPayload = ['cmd.exe', '/d', '/s', keepOpen ? '/k' : '/c', joinCmd(argv)];
  const wt = (cwdFlag: string[]): [string, string[]] => [
    'wt.exe',
    ['-w', 'new', '--title', title, ...cwdFlag, ...cmdPayload].map(wtEscape),
  ];

  // Each builder lists [program, args] in documented order; unavailable programs are filtered out below.
  const wsl = ['wsl.exe', ...(cwd === undefined ? [] : ['--cd', cwd]), '--exec', ...payload(false)];
  const table: Record<Platform, () => [string, string[]][]> = {
    wsl: () =>
      has('wsl.exe')
        ? [
            ['wt.exe', ['-w', 'new', '--title', title, ...wsl].map(wtEscape)],
            ['cmd.exe', ['/c', 'start', ...wsl.map(quoteCmd)]],
          ]
        : [],
    win32: () => [
      wt(cwd === undefined ? [] : ['-d', cwd]),
      // The outer cmd strips one caret layer, then the started cmd.exe itself reads the line (no argv parsing, so no
      // quoteCmd `\"` escaping): caret-escape only, and leave the already-escaped inner line unwrapped.
      ['cmd.exe', ['/c', 'start', ...[...(cwd === undefined ? [] : ['/D', /\s/.test(cwd) ? `"${cwd}"` : cwd]), ...cmdPayload].map(caretOnly)]],
    ],
    darwin: () => {
      const script = appleEscape(line(true));
      return [
        [
          'osascript',
          [
            '-e',
            env.env.TERM_PROGRAM === 'iTerm.app'
              ? `tell application "iTerm" to create window with default profile command "${script}"`
              : `tell application "Terminal" to do script "${script}"`,
          ],
        ],
      ];
    },
    linux: () =>
      env.env.DISPLAY || env.env.WAYLAND_DISPLAY
        ? LINUX_TERMINALS.map(([cmd, flags]) => [cmd, [...flags, ...payload(true)]])
        : [],
  };

  // LOOPWORK_TERMINAL wins everywhere: whitespace-split prefix, one step, no shell around the launch.
  const [override, ...overrideArgs] = env.env.LOOPWORK_TERMINAL?.match(/\S+/g) ?? [];
  const candidates: [string, string[]][] =
    override === undefined ? table[env.platform]() : [[override, [...overrideArgs, ...payload(true)]]];
  const steps = candidates
    .filter(([cmd]) => override !== undefined || has(cmd))
    .map(([command, args]) => ({ command, args }));

  return steps.length ? { steps, describe: `Open a terminal window via ${steps[0]!.command}` } : undefined;
}
