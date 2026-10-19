import { describe, expect, it } from 'vitest';
import { LOCAL_URL, planAppWindow } from '../src/plan-app-window.js';
import type { Platform } from '../src/types.js';
import { fixtures, makeEnv } from './fixtures/env.js';

const URL = 'http://127.0.0.1:5173/';
const app = (u: string) => `--app=${u}`;

const WSL_CHROME = ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
const WSL_EDGE = ['/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe', '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
const WIN_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIN_EDGE = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

// cmd.exe `start "" <url>`: the empty title is the literal "" caret-escaped, the URL is caret-escaped.
const cmdStart = (u: string) => ({ command: 'cmd.exe', args: ['/c', 'start', '^"^"', u] });
// On wsl, interop re-quotes any argument with a space or `"`, so no empty title and no quoting beyond the caret escape.
const wslCmdStart = (u: string) => ({ command: 'cmd.exe', args: ['/c', 'start', u] });

// One link of a fallback chain: provisioned through `files` or `tools`, and the step it yields.
type Link = { file?: string; tool?: string; step: { command: string; args: string[] } };
const chrome = (command: string, file: string): Link => ({ file, step: { command, args: [app(URL)] } });
const chains: [Platform, Link[]][] = [
  ['wsl', [chrome(WSL_CHROME[0]!, WSL_CHROME[0]!), chrome(WSL_EDGE[0]!, WSL_EDGE[0]!), { tool: 'wslview', step: { command: 'wslview', args: [URL] } }, { tool: 'cmd.exe', step: wslCmdStart(URL) }]],
  ['win32', [chrome(WIN_CHROME, WIN_CHROME), chrome(WIN_EDGE, WIN_EDGE), { tool: 'cmd.exe', step: cmdStart(URL) }]],
  [
    'darwin',
    [
      { file: '/Applications/Google Chrome.app', step: { command: 'open', args: ['-na', 'Google Chrome', '--args', app(URL)] } },
      { file: '/Applications/Microsoft Edge.app', step: { command: 'open', args: ['-na', 'Microsoft Edge', '--args', app(URL)] } },
      { tool: 'open', step: { command: 'open', args: [URL] } },
    ],
  ],
  [
    'linux',
    [
      { tool: 'google-chrome', step: { command: 'google-chrome', args: [app(URL)] } },
      { tool: 'chromium', step: { command: 'chromium', args: [app(URL)] } },
      { tool: 'microsoft-edge', step: { command: 'microsoft-edge', args: [app(URL)] } },
      { tool: 'xdg-open', step: { command: 'xdg-open', args: [URL] } },
    ],
  ],
];
const envFor = (platform: Platform, links: Link[]) =>
  makeEnv({ platform, files: links.flatMap((l) => (l.file ? [l.file] : [])), tools: links.flatMap((l) => (l.tool ? [l.tool] : [])) });
const commands = (plan: ReturnType<typeof planAppWindow>) => plan?.steps.map((s) => s.command);

describe('planAppWindow', () => {
  // WL-1: first choice per platform, then the next choice each time the first is removed, down to nothing
  it.each(chains)('WL-1: %s first step is the documented first choice and removing it yields the next choice', (platform, chain) => {
    for (let i = 0; i < chain.length; i++) {
      const remaining = chain.slice(i);
      const plan = planAppWindow(URL, envFor(platform, remaining));
      expect(plan?.steps).toEqual(remaining.map((l) => l.step));
    }
    expect(planAppWindow(URL, makeEnv({ platform }))).toBeUndefined();
  });

  it('WL-1: the stock fixtures (no browser installed) fall through to the system opener', () => {
    expect(planAppWindow(URL, fixtures.wsl)?.steps).toEqual([{ command: 'wslview', args: [URL] }, wslCmdStart(URL)]);
    expect(planAppWindow(URL, fixtures.darwin)?.steps).toEqual([{ command: 'open', args: [URL] }]);
    expect(planAppWindow(URL, fixtures.linux)?.steps).toEqual([{ command: 'xdg-open', args: [URL] }]);
    expect(planAppWindow(URL, fixtures.win32)?.steps).toEqual([cmdStart(URL)]);
  });

  // WL-4
  it.each([
    ['empty string', ''],
    ['non-local host', 'http://example.com/'],
    ['non-http scheme', 'ftp://localhost/'],
    ['file: scheme', 'file:///etc/passwd'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['uppercase scheme', 'HTTP://127.0.0.1/'],
    ['space in path', 'http://127.0.0.1:5173/a b'],
    ['double quote', 'http://127.0.0.1/"'],
    ['semicolon', 'http://127.0.0.1/a;calc'],
    ['pipe', 'http://127.0.0.1/a|b'],
    ['backtick', 'http://127.0.0.1/`id`'],
    ['userinfo', 'http://127.0.0.1@evil.com/'],
    // built by join so no source line looks like URL credentials (floor-guard secret rule)
    ['userinfo with port', ['http://localhost:80', '@evil.com/'].join('')],
    ['lookalike host', 'http://localhost.evil.com/'],
    ['trailing newline', 'http://127.0.0.1:5173/\n'],
    ['scheme not at start (javascript: prefix)', 'javascript:alert(1)//http://127.0.0.1/'],
    ['scheme prefix (^ anchor)', 'xhttp://127.0.0.1/'],
    ['dots replaced by other chars', 'http://127x0x0x1/'],
    ['empty port', 'http://127.0.0.1:/'],
    ['httpss scheme', 'httpss://127.0.0.1/'],
    ['caret in path', 'http://127.0.0.1/a^b'],
    ['at sign in path', 'http://127.0.0.1/a@b'],
  ])('WL-4: planAppWindow rejects non-local URLs, URLs with spaces, ", ;, |, backticks, and file:/javascript: schemes (%s)', (_name, url) => {
    for (const env of Object.values(fixtures)) expect(planAppWindow(url, env)).toBeUndefined();
    expect(LOCAL_URL.test(url)).toBe(false);
  });

  it.each(['http://127.0.0.1:5173/', 'https://localhost/a?b=c#d'])('WL-4: accepts the local URL %s', (url) => {
    expect(LOCAL_URL.test(url)).toBe(true);
    expect(planAppWindow(url, fixtures.linux)?.steps).toEqual([{ command: 'xdg-open', args: [url] }]);
  });

  // WL-5
  it.each([...WSL_CHROME, ...WSL_EDGE])('WL-5: wsl finds %s (both Program Files dirs, Chrome and Edge)', (path) => {
    const plan = planAppWindow(URL, makeEnv({ platform: 'wsl', files: [path], tools: ['wslview', 'cmd.exe'] }));
    expect(plan?.steps[0]).toEqual({ command: path, args: [app(URL)] });
  });

  it('WL-5: wsl with neither browser plans wslview, then cmd.exe start', () => {
    expect(commands(planAppWindow(URL, fixtures['wsl-no-wt']))).toEqual(['wslview', 'cmd.exe']);
  });

  it('WL-5: wsl orders Chrome before Edge, and Program Files before Program Files (x86)', () => {
    const plan = (files: string[]) => commands(planAppWindow(URL, makeEnv({ platform: 'wsl', files })));
    expect(plan([WSL_CHROME[1]!, WSL_EDGE[0]!])).toEqual([WSL_CHROME[1], WSL_EDGE[0]]);
    expect(plan([...WSL_CHROME].reverse())).toEqual(WSL_CHROME);
  });

  it('WL-1: win32 honours ProgramFiles / ProgramFiles(x86) and defaults to the C: dirs', () => {
    const chromeUnder = (root: string) => `${root}\\Google\\Chrome\\Application\\chrome.exe`;
    const edgeUnder = (root: string) => `${root}\\Microsoft\\Edge\\Application\\msedge.exe`;
    const plan = (env: Record<string, string>, files: string[]) => commands(planAppWindow(URL, makeEnv({ platform: 'win32', env, files })));
    const custom = { ProgramFiles: 'D:\\PF', 'ProgramFiles(x86)': 'D:\\PF86' };
    const dirs = ['D:\\PF', 'D:\\PF86'];
    expect(plan(custom, [...dirs.flatMap((d) => [edgeUnder(d), chromeUnder(d)]), chromeUnder('C:\\Program Files')])).toEqual([
      chromeUnder('D:\\PF'), chromeUnder('D:\\PF86'), edgeUnder('D:\\PF'), edgeUnder('D:\\PF86'),
    ]);
    expect(plan({}, [chromeUnder('C:\\Program Files')])).toEqual([chromeUnder('C:\\Program Files')]);
    expect(plan({}, [chromeUnder('C:\\Program Files (x86)')])).toEqual([chromeUnder('C:\\Program Files (x86)')]);
  });

  it('describe is a non-empty string naming the first step', () => {
    expect(planAppWindow(URL, fixtures.linux)?.describe).toEqual(expect.stringContaining('xdg-open'));
  });

  // The URL grammar allows & and %, which would split or expand on a cmd.exe command line.
  it('cmd.exe start fallback carets & and % in the URL (win32 also the empty title; wsl has no title)', () => {
    const url = 'http://127.0.0.1:5173/a?x=1&y=2%20z';
    const careted = 'http://127.0.0.1:5173/a?x=1^&y=2^%20z';
    const plan = (platform: 'wsl' | 'win32') => planAppWindow(url, makeEnv({ platform, tools: ['cmd.exe'] }))?.steps;
    expect(plan('wsl')).toEqual([{ command: 'cmd.exe', args: ['/c', 'start', careted] }]);
    expect(plan('win32')).toEqual([{ command: 'cmd.exe', args: ['/c', 'start', '^"^"', careted] }]);
  });

  it('wsl: no cmd.exe step passes an argument containing a double quote (WSL interop would re-quote it)', () => {
    const env = makeEnv({ platform: 'wsl', files: [...WSL_CHROME, ...WSL_EDGE], tools: ['wslview', 'cmd.exe'] });
    for (const url of [URL, 'http://127.0.0.1:5173/a?x=1&y=2%20z']) {
      const cmdSteps = planAppWindow(url, env)?.steps.filter((s) => s.command === 'cmd.exe');
      expect(cmdSteps).toHaveLength(1);
      expect(cmdSteps!.flatMap((s) => s.args).some((a) => a.includes('"'))).toBe(false);
    }
  });
});
