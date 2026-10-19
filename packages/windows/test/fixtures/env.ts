import type { LaunchEnv, Platform } from '../../src/types.js';

// Pure test double: no real FS or PATH access. `which` resolves only the listed tools.
export function makeEnv(opts: { platform: Platform; env?: Record<string, string>; tools?: string[]; files?: string[] }): LaunchEnv {
  const tools = new Set(opts.tools ?? []);
  const files = new Set(opts.files ?? []);
  return {
    platform: opts.platform,
    env: { ...opts.env },
    exists: (path) => files.has(path),
    which: (cmd) => (tools.has(cmd) ? `/usr/bin/${cmd}` : undefined),
  };
}

const wslTools = ['wsl.exe', 'cmd.exe', 'wslview'];
const posixOpeners = ['xdg-open', 'x-terminal-emulator'];

export const fixtures = {
  wsl: makeEnv({ platform: 'wsl', env: { WSL_DISTRO_NAME: 'Ubuntu' }, tools: ['wt.exe', ...wslTools] }),
  'wsl-no-wt': makeEnv({ platform: 'wsl', env: { WSL_DISTRO_NAME: 'Ubuntu' }, tools: wslTools }),
  darwin: makeEnv({ platform: 'darwin', env: { TERM_PROGRAM: 'Apple_Terminal' }, tools: ['osascript', 'open'] }),
  'darwin-iterm': makeEnv({ platform: 'darwin', env: { TERM_PROGRAM: 'iTerm.app' }, tools: ['osascript', 'open'] }),
  linux: makeEnv({ platform: 'linux', env: { DISPLAY: ':0' }, tools: posixOpeners }),
  'linux-no-display': makeEnv({ platform: 'linux', tools: posixOpeners }),
  'linux-custom-terminal': makeEnv({ platform: 'linux', env: { DISPLAY: ':0', LOOPWORK_TERMINAL: 'alacritty -e' }, tools: [...posixOpeners, 'alacritty'] }),
  win32: makeEnv({ platform: 'win32', tools: ['wt.exe', 'cmd.exe'] }),
} satisfies Record<string, LaunchEnv>;
