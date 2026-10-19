import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { caretOnly, planTerminal } from './plan-terminal.js';
import { planAppWindow } from './plan-app-window.js';
import { detectPlatform } from './platform.js';
import { joinCmd, joinPosix, quotePosix } from './quote.js';
import type { LaunchEnv, LaunchPlan, LaunchResult, Platform, TerminalRequest } from './types.js';

type SpawnFn = typeof nodeSpawn;
type Deps = { spawn?: SpawnFn };

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The real environment: process platform/env, the real filesystem, and a PATH scan (PATHEXT on win32). */
export function defaultLaunchEnv(platform: string = process.platform, env: Record<string, string | undefined> = process.env): LaunchEnv {
  const readFile = (p: string): string | undefined => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  return {
    platform: detectPlatform(env, { exists: existsSync, readFile }, platform),
    env,
    exists: existsSync,
    which: (cmd) =>
      (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => exts.map((ext) => join(dir, cmd + ext)))
        .find(isFile),
  };
}

// Resolves with undefined once the child spawned, or with the failure message.
function tryStep(spawn: SpawnFn, command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      // The cmd.exe args are pre-escaped command-line text: libuv must not re-quote them.
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...(basename(command).toLowerCase() === 'cmd.exe' && { windowsVerbatimArguments: true }),
      });
      child.once('error', (e: Error) => resolve(e.message));
      child.once('spawn', () => {
        child.unref();
        resolve(undefined);
      });
    } catch (e) {
      resolve((e as Error).message);
    }
  });
}

async function launch(plan: LaunchPlan | undefined, spawn: SpawnFn, noPlan: string, fallback: string): Promise<LaunchResult> {
  const failures: string[] = [];
  for (const { command, args } of plan?.steps ?? []) {
    const failure = await tryStep(spawn, command, args);
    if (failure === undefined) return { status: 'launched', via: command };
    failures.push(`${command}: ${failure}`);
  }
  return { status: 'unsupported', reason: failures.length ? failures.join('; ') : noPlan, fallback };
}

// The original command line, quoted for the platform's shell, so the user can paste it themselves.
function terminalFallback({ argv, cwd }: TerminalRequest, platform: Platform): string {
  return platform === 'win32'
    ? (cwd === undefined ? '' : `cd /d ${caretOnly(/\s/.test(cwd) ? `"${cwd}"` : cwd)} && `) + joinCmd(argv)
    : (cwd === undefined ? '' : `cd -- ${quotePosix(cwd)} && `) + joinPosix(argv);
}

export function openTerminal(req: TerminalRequest, env: LaunchEnv = defaultLaunchEnv(), deps: Deps = {}): Promise<LaunchResult> {
  return launch(planTerminal(req, env), deps.spawn ?? nodeSpawn, `no terminal strategy available on ${env.platform}`, terminalFallback(req, env.platform));
}

export function openAppWindow(url: string, env: LaunchEnv = defaultLaunchEnv(), deps: Deps = {}): Promise<LaunchResult> {
  return launch(planAppWindow(url, env), deps.spawn ?? nodeSpawn, `no app-window strategy available for ${url} on ${env.platform}`, url);
}
