import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLaunchEnv, openAppWindow, openTerminal } from '../src/execute.js';
import { joinCmd, joinPosix, quotePosix } from '../src/quote.js';
import { fixtures, makeEnv } from './fixtures/env.js';

type Spawn = NonNullable<NonNullable<Parameters<typeof openTerminal>[2]>['spawn']>;
type Outcome = 'ok' | Error | { throws: Error };
type Call = { command: string; args: string[]; options: Record<string, unknown> };

// Fake spawn: one outcome per call (the last repeats). Events fire asynchronously, after the caller got the child.
function fakeSpawn(...outcomes: Outcome[]) {
  const calls: Call[] = [];
  const unrefs: ReturnType<typeof vi.fn>[] = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)]!;
    calls.push({ command, args, options });
    if (typeof outcome === 'object' && 'throws' in outcome) throw outcome.throws;
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    unrefs.push(child.unref);
    queueMicrotask(() => (outcome === 'ok' ? child.emit('spawn') : child.emit('error', outcome)));
    return child;
  }) as unknown as Spawn;
  return { spawn, calls, unrefs };
}

const argv = ['echo', 'hi there'];
const enoent = (name: string) => Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' });

describe('openTerminal', () => {
  it('first step spawning successfully yields launched via its command, detached with ignored stdio and unref', async () => {
    const { spawn, calls, unrefs } = fakeSpawn('ok');
    expect(await openTerminal({ argv }, fixtures.linux, { spawn })).toEqual({ status: 'launched', via: 'x-terminal-emulator' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(calls[0]!.options.windowsVerbatimArguments).not.toBe(true);
    expect(unrefs[0]).toHaveBeenCalledTimes(1);
  });

  it('WL-8: a failed first step falls through to the next', async () => {
    const { spawn, calls, unrefs } = fakeSpawn(enoent('wt.exe'), 'ok');
    expect(await openTerminal({ argv }, fixtures.win32, { spawn })).toEqual({ status: 'launched', via: 'cmd.exe' });
    expect(calls.map((c) => c.command)).toEqual(['wt.exe', 'cmd.exe']);
    expect(unrefs.at(-1)).toHaveBeenCalledTimes(1);
  });

  it('WL-8: a synchronous throw from spawn() counts as a failed step', async () => {
    const { spawn, calls } = fakeSpawn({ throws: new Error('EACCES nope') }, 'ok');
    expect(await openTerminal({ argv }, fixtures.win32, { spawn })).toEqual({ status: 'launched', via: 'cmd.exe' });
    expect(calls).toHaveLength(2);
  });

  it('WL-8: all steps failing yields unsupported with the failure reasons', async () => {
    const { spawn, calls } = fakeSpawn(new Error('boom-one'), { throws: new Error('boom-two') });
    const result = await openTerminal({ argv }, fixtures.win32, { spawn });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ status: 'unsupported', fallback: joinCmd(argv) });
    expect(result.status === 'unsupported' && result.reason).toBe('wt.exe: boom-one; cmd.exe: boom-two');
  });

  it('spawn options: windowsVerbatimArguments is true only for cmd.exe steps', async () => {
    const { spawn, calls } = fakeSpawn(new Error('x'));
    await openTerminal({ argv }, fixtures.win32, { spawn });
    expect(calls.map((c) => c.command)).toEqual(['wt.exe', 'cmd.exe']);
    for (const c of calls) {
      expect(c.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: false });
      expect(c.options.windowsVerbatimArguments === true).toBe(c.command === 'cmd.exe');
    }
  });

  it('wsl: wt.exe is the only step; its failure (or a missing wt.exe) is unsupported with the pasteable command line, never cmd.exe', async () => {
    const failing = fakeSpawn(new Error('boom-one'));
    const result = await openTerminal({ argv }, fixtures.wsl, { spawn: failing.spawn });
    expect(failing.calls.map((c) => c.command)).toEqual(['wt.exe']);
    expect(result).toMatchObject({ status: 'unsupported', fallback: joinPosix(argv) });
    expect(result.status === 'unsupported' && result.reason).toBe('wt.exe: boom-one');
    const none = fakeSpawn('ok');
    expect(await openTerminal({ argv }, fixtures['wsl-no-wt'], { spawn: none.spawn })).toMatchObject({ status: 'unsupported', fallback: joinPosix(argv) });
    expect(none.calls).toHaveLength(0);
  });

  it('no plan at all is unsupported with a reason and the quoted command line, never spawning', async () => {
    const { spawn, calls } = fakeSpawn('ok');
    const result = await openTerminal({ argv }, makeEnv({ platform: 'darwin' }), { spawn });
    expect(result).toMatchObject({ status: 'unsupported', fallback: joinPosix(argv) });
    expect(result.status === 'unsupported' && result.reason).toMatch(/darwin/);
    expect(calls).toHaveLength(0);
  });

  it('WL-2: linux without DISPLAY/WAYLAND_DISPLAY returns unsupported with the original command line, correctly quoted, as fallback', async () => {
    const hostile = ['a b', "it's", '$(touch pwned)', '`id`', '"q"', 'a;b|c', '', '-n', 'back\\slash', 'new\nline'];
    const { spawn, calls } = fakeSpawn('ok');
    const result = await openTerminal({ argv: ['printf', '%s\\0', ...hostile] }, fixtures['linux-no-display'], { spawn });
    expect(calls).toHaveLength(0);
    expect(result.status).toBe('unsupported');
    if (result.status !== 'unsupported') return;
    // The fallback, run by a real sh, reproduces the argv (printf echoes each argument NUL-terminated).
    const out = execFileSync('sh', ['-c', result.fallback], { encoding: 'utf8' });
    expect(out.split('\0').slice(0, -1)).toEqual(hostile);
  });

  it('fallback gets a `cd -- <cwd> &&` prefix on posix and `cd /d <cwd> &&` on win32', async () => {
    const posix = await openTerminal({ argv, cwd: "/my dir's" }, fixtures['linux-no-display']);
    expect(posix).toMatchObject({ status: 'unsupported', fallback: `cd -- ${quotePosix("/my dir's")} && ${joinPosix(argv)}` });
    const win = await openTerminal({ argv, cwd: 'C:\\work' }, makeEnv({ platform: 'win32' }));
    expect(win).toMatchObject({ status: 'unsupported', fallback: `cd /d C:\\work && ${joinCmd(argv)}` });
  });

  // Security: the win32 fallback cwd is pasted into a cmd.exe line, so metacharacters are caret-escaped and
  // whitespace is plain-quoted first (same treatment as the cmd.exe `start /D` planner step).
  it('win32 fallback caret-escapes cmd metacharacters in cwd and quotes whitespace', async () => {
    const env = makeEnv({ platform: 'win32' });
    const fallback = async (cwd: string) => {
      const r = await openTerminal({ argv, cwd }, env);
      return r.status === 'unsupported' ? r.fallback : '';
    };
    expect(await fallback('C:\\a&b')).toBe(`cd /d C:\\a^&b && ${joinCmd(argv)}`);
    expect(await fallback('C:\\my dir')).toBe(`cd /d ^"C:\\my dir^" && ${joinCmd(argv)}`);
  });
});

describe('openAppWindow', () => {
  it('launches a local URL via the first step that spawns', async () => {
    const { spawn, calls } = fakeSpawn('ok');
    expect(await openAppWindow('http://localhost:3000/', fixtures.linux, { spawn })).toEqual({ status: 'launched', via: 'xdg-open' });
    expect(calls[0]).toMatchObject({ command: 'xdg-open', args: ['http://localhost:3000/'] });
  });

  it('WL-4: openAppWindow returns unsupported with the URL as fallback for non-local URLs', async () => {
    const { spawn, calls } = fakeSpawn('ok');
    const url = 'http://evil.example.com/x';
    const result = await openAppWindow(url, fixtures.linux, { spawn });
    expect(result).toMatchObject({ status: 'unsupported', fallback: url });
    expect(calls).toHaveLength(0);
  });
});

describe('defaultLaunchEnv', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('which scans PATH for an existing file and ignores directories and misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopwork-which-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'mytool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'mytool'), 0o755);
    mkdirSync(join(dir, 'adir'));
    const env = defaultLaunchEnv('linux', { PATH: dir });
    // The default adapter reads the real /proc/version, so a WSL host reports 'wsl' even for a 'linux' process.platform.
    expect(['linux', 'wsl']).toContain(env.platform);
    expect(env.which('mytool')).toBe(join(dir, 'mytool'));
    expect(env.which('adir')).toBeUndefined();
    expect(env.which('missing')).toBeUndefined();
    expect(env.exists(join(dir, 'mytool'))).toBe(true);
  });
});
