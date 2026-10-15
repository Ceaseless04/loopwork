import { caretOnly } from './plan-terminal.js';
import type { LaunchEnv, LaunchPlan, Platform } from './types.js';

export const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~:/?=#&%-]*)?$/;

const BROWSERS = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
const MAC_APPS = ['Google Chrome', 'Microsoft Edge'];
const LINUX_BROWSERS = ['google-chrome', 'chromium', 'microsoft-edge'];

export function planAppWindow(url: string, env: LaunchEnv): LaunchPlan | undefined {
  if (!LOCAL_URL.test(url)) return undefined;
  const has = (cmd: string): boolean => env.which(cmd) !== undefined;
  const app = `--app=${url}`;
  // Chrome before Edge, each under both Program Files dirs; `join` is the platform's path separator.
  const exe = (roots: string[], join: string): [string, string[]][] =>
    BROWSERS.flatMap((b) => roots.map((r) => `${r}${join}${b.replaceAll('/', join)}`))
      .filter((p) => env.exists(p))
      .map((p) => [p, [app]]);
  // `start "" <url>`: caret-escape every token, including the literal empty title.
  const cmdStart = (): [string, string[]][] =>
    has('cmd.exe') ? [['cmd.exe', ['/c', 'start', ...['""', url].map(caretOnly)]]] : [];
  const open = (cmd: string): [string, string[]][] => (has(cmd) ? [[cmd, [url]]] : []);

  const table: Record<Platform, () => [string, string[]][]> = {
    wsl: () => [...exe(['/mnt/c/Program Files', '/mnt/c/Program Files (x86)'], '/'), ...open('wslview'), ...cmdStart()],
    win32: () => [
      ...exe([env.env.ProgramFiles ?? 'C:\\Program Files', env.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'], '\\'),
      ...cmdStart(),
    ],
    darwin: () => [
      ...MAC_APPS.filter((a) => env.exists(`/Applications/${a}.app`)).map((a): [string, string[]] => ['open', ['-na', a, '--args', app]]),
      ...open('open'),
    ],
    linux: () => [...LINUX_BROWSERS.filter(has).map((b): [string, string[]] => [b, [app]]), ...open('xdg-open')],
  };

  const steps = table[env.platform]().map(([command, args]) => ({ command, args }));
  return steps.length ? { steps, describe: `Open an app window via ${steps[0]!.command}` } : undefined;
}
