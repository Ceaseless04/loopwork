import { describe, expect, it } from 'vitest';
import { planTerminal } from '../src/plan-terminal.js';
import { joinCmd, joinPosix, quoteCmd, quotePosix } from '../src/quote.js';
import type { Platform } from '../src/types.js';
import { fixtures, makeEnv } from './fixtures/env.js';

const argv = ['echo', 'hi there'];
const KEEP_TAIL = '; printf "\\n[loopwork exited — press Enter to close]"; read _';
const keepPayload = (cmdline: string) => ['sh', '-c', cmdline + KEEP_TAIL];
const wtEscape = (s: string) => s.replaceAll(';', '\\;');
const appleEscape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const bareSemicolon = /(^|[^\\]);/;
const commands = (plan: ReturnType<typeof planTerminal>) => plan?.steps.map((s) => s.command);

describe('planTerminal', () => {
  // WL-1: documented first choice per fixture (command + leading args)
  it.each([
    ['wsl', 'wt.exe', ['-w', 'new', '--title', 'T', 'wsl.exe', '--cd', '/work', '--']],
    ['wsl-no-wt', 'cmd.exe', ['/c', 'start', 'wsl.exe']],
    ['darwin', 'osascript', ['-e']],
    ['darwin-iterm', 'osascript', ['-e']],
    ['linux', 'x-terminal-emulator', ['-e']],
    ['win32', 'wt.exe', ['-w', 'new', '--title', 'T', '-d', '/work', 'cmd.exe']],
  ] as const)('WL-1: %s first step is the documented first choice', (name, command, prefix) => {
    const step = planTerminal({ argv, cwd: '/work', title: 'T' }, fixtures[name])?.steps[0];
    expect(step?.command).toBe(command);
    expect(step?.args.slice(0, prefix.length)).toEqual(prefix);
  });

  it('WL-1: darwin uses Terminal, or iTerm when TERM_PROGRAM=iTerm.app', () => {
    const script = (name: 'darwin' | 'darwin-iterm') => planTerminal({ argv }, fixtures[name])?.steps[0]?.args[1];
    expect(script('darwin')).toContain('tell application "Terminal"');
    expect(script('darwin-iterm')).toContain('tell application "iTerm"');
  });

  // WL-1: removing the first tool from `which` yields the next choice, down to nothing
  const chains: [Platform, Record<string, string>, string[], [string, string[]][]][] = [
    ['wsl', { WSL_DISTRO_NAME: 'Ubuntu' }, ['wsl.exe'], [['wt.exe', ['-w', 'new', '--title', 'loopwork']], ['cmd.exe', ['/c', 'start', 'wsl.exe']]]],
    ['win32', {}, [], [['wt.exe', ['-w', 'new', '--title', 'loopwork']], ['cmd.exe', ['/c', 'start']]]],
    ['darwin', {}, [], [['osascript', ['-e']]]],
    [
      'linux',
      { DISPLAY: ':0' },
      [],
      [
        ['x-terminal-emulator', ['-e']],
        ['gnome-terminal', ['--']],
        ['kitty', []],
        ['konsole', ['-e']],
        ['xterm', ['-e']],
      ],
    ],
  ];
  it.each(chains)('WL-1: removing that tool from which yields the next choice (%s)', (platform, env, extra, chain) => {
    for (let i = 0; i < chain.length; i++) {
      const remaining = chain.slice(i);
      const plan = planTerminal({ argv }, makeEnv({ platform, env, tools: [...extra, ...remaining.map(([c]) => c)] }));
      expect(commands(plan)).toEqual(remaining.map(([c]) => c));
      const [, prefix] = remaining[0]!;
      expect(plan?.steps[0]?.args.slice(0, prefix.length)).toEqual(prefix);
    }
    expect(planTerminal({ argv }, makeEnv({ platform, env, tools: extra }))).toBeUndefined();
  });

  it('WL-1: linux without DISPLAY/WAYLAND_DISPLAY has no terminal strategy', () => {
    expect(planTerminal({ argv }, fixtures['linux-no-display'])).toBeUndefined();
  });

  // WL-6
  it('WL-6: keepOpen true (default) wraps the command', () => {
    const line = joinPosix(argv);
    expect(planTerminal({ argv }, fixtures.linux)?.steps[0]).toEqual({ command: 'x-terminal-emulator', args: ['-e', ...keepPayload(line)] });
    expect(planTerminal({ argv, cwd: '/work', title: 'T' }, fixtures.wsl)?.steps[0]?.args).toEqual([
      '-w', 'new', '--title', 'T', 'wsl.exe', '--cd', '/work', '--', 'sh', '-c', wtEscape(line + KEEP_TAIL),
    ]);
    expect(planTerminal({ argv, cwd: 'C:\\work', title: 'T' }, fixtures.win32)?.steps[0]?.args.slice(-5)).toEqual(['cmd.exe', '/d', '/s', '/k', joinCmd(argv)]);
  });

  it('WL-6: keepOpen false does not wrap', () => {
    const req = { argv, cwd: '/work', title: 'T', keepOpen: false };
    expect(planTerminal({ argv, keepOpen: false }, fixtures.linux)?.steps[0]?.args).toEqual(['-e', ...argv]);
    expect(planTerminal(req, fixtures.wsl)?.steps[0]?.args.slice(-3)).toEqual(['--', ...argv]);
    expect(planTerminal(req, fixtures.win32)?.steps[0]?.args.slice(-5)).toEqual(['cmd.exe', '/d', '/s', '/c', joinCmd(argv)]);
  });

  it('cwd without a terminal flag goes in a `cd --` prefix inside the sh payload', () => {
    const args = planTerminal({ argv, cwd: "/my dir's", keepOpen: false }, fixtures.linux)?.steps[0]?.args;
    expect(args).toEqual(['-e', 'sh', '-c', `cd -- ${quotePosix("/my dir's")} && ${joinPosix(argv)}`]);
  });

  it('darwin: cwd becomes a `cd --` prefix in the script line, AppleScript-escaped', () => {
    const cwd = '/my "dir"';
    const line = `cd -- ${quotePosix(cwd)} && ${joinPosix(argv)}${KEEP_TAIL}`;
    expect(planTerminal({ argv, cwd }, fixtures.darwin)?.steps[0]?.args).toEqual(['-e', `tell application "Terminal" to do script "${appleEscape(line)}"`]);
  });

  it('wsl: the cmd.exe /c start wsl.exe fallback quotes every argument after start via quoteCmd', () => {
    const hostile = ['echo', 'a&b c'];
    const wslArgs = ['wsl.exe', '--cd', '/my work', '--', ...keepPayload(joinPosix(hostile))];
    const step = planTerminal({ argv: hostile, cwd: '/my work' }, fixtures['wsl-no-wt'])?.steps[0];
    expect(step).toEqual({ command: 'cmd.exe', args: ['/c', 'start', ...wslArgs.map(quoteCmd)] });
  });

  it('win32: the cmd.exe /c start fallback is parsed by cmd twice, so every argument after start is quoteCmd-ed again', () => {
    const hostile = ['echo', 'a&calc'];
    const env = makeEnv({ platform: 'win32', tools: ['cmd.exe'] });
    const inner = ['/D', 'C:\\my work', 'cmd.exe', '/d', '/s', '/k', joinCmd(hostile)];
    expect(planTerminal({ argv: hostile, cwd: 'C:\\my work' }, env)?.steps).toEqual([{ command: 'cmd.exe', args: ['/c', 'start', ...inner.map(quoteCmd)] }]);
    const noCwd = ['cmd.exe', '/d', '/s', '/c', joinCmd(hostile)];
    expect(planTerminal({ argv: hostile, keepOpen: false }, env)?.steps[0]?.args).toEqual(['/c', 'start', ...noCwd.map(quoteCmd)]);
  });

  it('linux: WAYLAND_DISPLAY alone (no DISPLAY) allows terminals', () => {
    const env = makeEnv({ platform: 'linux', env: { WAYLAND_DISPLAY: 'w0' }, tools: ['x-terminal-emulator'] });
    expect(commands(planTerminal({ argv }, env))).toEqual(['x-terminal-emulator']);
  });

  it('linux: kitty takes the payload with no flags', () => {
    const env = makeEnv({ platform: 'linux', env: { DISPLAY: ':0' }, tools: ['kitty'] });
    expect(planTerminal({ argv }, env)?.steps).toEqual([{ command: 'kitty', args: keepPayload(joinPosix(argv)) }]);
  });

  it('a program path with spaces as first token is caret-quoted via joinCmd', () => {
    const prog = ['C:\\Program Files\\App\\app.exe', '--x'];
    const last = planTerminal({ argv: prog }, fixtures.win32)?.steps[0]?.args.at(-1);
    expect(last).toBe(joinCmd(prog));
    expect(last?.startsWith('^"C:\\Program Files\\App\\app.exe^"')).toBe(true);
  });

  it('wt.exe: every `;` in an argument is written `\\;`', () => {
    const hostile = ['echo', 'a;b'];
    for (const [env, req] of [
      [fixtures.wsl, { argv: hostile }],
      [fixtures.wsl, { argv: hostile, keepOpen: false }],
      [fixtures.win32, { argv: hostile }],
    ] as const) {
      const step = planTerminal(req, env)?.steps[0];
      expect(step?.command).toBe('wt.exe');
      expect(step?.args.some((a) => bareSemicolon.test(a))).toBe(false);
      expect(step?.args.join(' ')).toContain('\\;');
    }
    expect(planTerminal({ argv: hostile, keepOpen: false }, fixtures.wsl)?.steps[0]?.args.at(-1)).toBe('a\\;b');
  });

  it('darwin: the AppleScript string literal escapes backslash and double quote', () => {
    const hostile = ['echo', 'a"b\\c" & do shell script "x'];
    const line = joinPosix(hostile) + KEEP_TAIL;
    const terminal = planTerminal({ argv: hostile }, fixtures.darwin)?.steps[0];
    expect(terminal).toEqual({ command: 'osascript', args: ['-e', `tell application "Terminal" to do script "${appleEscape(line)}"`] });
    const iterm = planTerminal({ argv: hostile }, fixtures['darwin-iterm'])?.steps[0]?.args[1];
    expect(iterm).toContain(`"${appleEscape(line)}"`);
  });

  // WL-7
  it('WL-7: LOOPWORK_TERMINAL overrides discovery and is split on whitespace into argv', () => {
    const plan = planTerminal({ argv }, fixtures['linux-custom-terminal']);
    expect(plan?.steps).toEqual([{ command: 'alacritty', args: ['-e', ...keepPayload(joinPosix(argv))] }]);
    const spaced = makeEnv({ platform: 'linux', env: { LOOPWORK_TERMINAL: '  foot   --app-id  x ' }, tools: ['foot'] });
    expect(planTerminal({ argv, keepOpen: false }, spaced)?.steps).toEqual([{ command: 'foot', args: ['--app-id', 'x', ...argv] }]);
  });

  it.each(['wsl', 'darwin', 'linux', 'win32'] as const)('WL-7: LOOPWORK_TERMINAL wins over the %s table and a missing DISPLAY', (platform) => {
    const env = makeEnv({
      platform,
      env: { LOOPWORK_TERMINAL: 'myterm -x' },
      tools: ['myterm', 'wt.exe', 'wsl.exe', 'cmd.exe', 'osascript', 'x-terminal-emulator'],
    });
    expect(planTerminal({ argv }, env)?.steps).toEqual([{ command: 'myterm', args: ['-x', ...keepPayload(joinPosix(argv))] }]);
  });

  it('WL-7: LOOPWORK_TERMINAL is not filtered by which (the override wins even if its binary is absent)', () => {
    const env = makeEnv({ platform: 'linux', env: { LOOPWORK_TERMINAL: 'myterm -x' }, tools: ['x-terminal-emulator'] });
    expect(planTerminal({ argv, keepOpen: false }, env)?.steps).toEqual([{ command: 'myterm', args: ['-x', ...argv] }]);
  });

  it('WL-7: a blank LOOPWORK_TERMINAL is ignored', () => {
    const tools = ['x-terminal-emulator'];
    expect(commands(planTerminal({ argv }, makeEnv({ platform: 'linux', env: { DISPLAY: ':0', LOOPWORK_TERMINAL: '   ' }, tools })))).toEqual(tools);
    expect(planTerminal({ argv }, makeEnv({ platform: 'linux', env: { LOOPWORK_TERMINAL: ' ' }, tools }))).toBeUndefined();
  });
});
