import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import type { LaunchEnv, LaunchPlan, LaunchResult, Platform, TerminalRequest } from '../src/index.js';

describe('@loopwork/windows public surface', () => {
  it('exports exactly the five functions', () => {
    expect(Object.keys(api).sort()).toEqual(['detectPlatform', 'openAppWindow', 'openTerminal', 'planAppWindow', 'planTerminal']);
  });

  // Type pins: vitest does not typecheck, so these are enforced only by the root `pnpm typecheck`.
  it('exposes the public types', () => {
    const platform: Platform = 'linux';
    const env: LaunchEnv = { platform, env: {}, exists: () => false, which: () => undefined };
    const req: TerminalRequest = { argv: ['echo'], cwd: '/w', title: 't', keepOpen: false };
    const plan: LaunchPlan = { steps: [{ command: 'x', args: [] }], describe: 'd' };
    const results: LaunchResult[] = [
      { status: 'launched', via: 'x' },
      { status: 'unsupported', reason: 'r', fallback: 'f' },
    ];
    expect([env, req, plan, results]).toHaveLength(4);
  });
});
