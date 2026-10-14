import { describe, expect, it } from 'vitest';
import { detectPlatform } from '../src/platform.js';
import { fixtures, makeEnv } from './fixtures/env.js';

const fsWith = (procVersion?: string) => ({
  exists: (p: string) => p === '/proc/version' && procVersion !== undefined,
  readFile: (p: string) => (p === '/proc/version' ? procVersion : undefined),
});

describe('detectPlatform', () => {
  it('T19: win32 -> win32', () => {
    expect(detectPlatform({}, fsWith(), 'win32')).toBe('win32');
  });

  it('T19: darwin -> darwin', () => {
    expect(detectPlatform({}, fsWith(), 'darwin')).toBe('darwin');
  });

  it('T19: linux with /proc/version mentioning microsoft -> wsl', () => {
    expect(detectPlatform({}, fsWith('Linux version 5.15.0-microsoft-standard-WSL2'), 'linux')).toBe('wsl');
  });

  it('T19: linux with /proc/version mentioning WSL -> wsl', () => {
    expect(detectPlatform({}, fsWith('Linux version 6.1 (WSL build)'), 'linux')).toBe('wsl');
  });

  it('T19: linux with WSL1-style capitalised Microsoft in /proc/version -> wsl', () => {
    expect(detectPlatform({}, fsWith('Linux version 4.4.0-19041-Microsoft'), 'linux')).toBe('wsl');
  });

  it('T19: linux with empty WSL_DISTRO_NAME and plain /proc/version -> linux', () => {
    expect(detectPlatform({ WSL_DISTRO_NAME: '' }, fsWith('Linux version 6.1.0-generic'), 'linux')).toBe('linux');
  });

  it('T19: linux with WSL_DISTRO_NAME set -> wsl', () => {
    expect(detectPlatform({ WSL_DISTRO_NAME: 'Ubuntu' }, fsWith('Linux version 6.1.0-generic'), 'linux')).toBe('wsl');
  });

  it('T19: plain linux -> linux', () => {
    expect(detectPlatform({}, fsWith('Linux version 6.1.0-generic'), 'linux')).toBe('linux');
    expect(detectPlatform({}, fsWith(), 'linux')).toBe('linux');
  });
});

describe('makeEnv fixtures', () => {
  it('T19: makeEnv resolves only listed tools and files', () => {
    const e = makeEnv({ platform: 'linux', env: { A: '1' }, tools: ['xterm'], files: ['/x'] });
    expect(e.platform).toBe('linux');
    expect(e.env).toEqual({ A: '1' });
    expect(e.which('xterm')).toBe('/usr/bin/xterm');
    expect(e.which('kitty')).toBeUndefined();
    expect(e.exists('/x')).toBe(true);
    expect(e.exists('/y')).toBe(false);
  });

  it('T19: the eight named scenario fixtures describe their platform and tools', () => {
    expect(Object.keys(fixtures).sort()).toEqual(['darwin', 'darwin-iterm', 'linux', 'linux-custom-terminal', 'linux-no-display', 'win32', 'wsl', 'wsl-no-wt']);
    expect(fixtures.wsl.platform).toBe('wsl');
    expect(fixtures.wsl.which('wt.exe')).toBeDefined();
    expect(fixtures['wsl-no-wt'].platform).toBe('wsl');
    expect(fixtures['wsl-no-wt'].which('wt.exe')).toBeUndefined();
    expect(fixtures.darwin.env.TERM_PROGRAM).not.toBe('iTerm.app');
    expect(fixtures['darwin-iterm'].env.TERM_PROGRAM).toBe('iTerm.app');
    expect(fixtures.linux.env.DISPLAY).toBeDefined();
    expect(fixtures['linux-no-display'].env.DISPLAY).toBeUndefined();
    expect(fixtures['linux-no-display'].env.WAYLAND_DISPLAY).toBeUndefined();
    expect(fixtures['linux-custom-terminal'].env.LOOPWORK_TERMINAL).toBe('alacritty -e');
    expect(fixtures.win32.platform).toBe('win32');
    expect(fixtures.win32.which('wt.exe')).toBeDefined();
  });
});
