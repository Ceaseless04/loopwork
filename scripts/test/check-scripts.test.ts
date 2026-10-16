import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const rootScripts = (): Record<string, string> => (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

const DB_URL = 'postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test';

/** `[allowlist]`-style table bodies of .gitleaks.toml, found by line scanning (no TOML dependency); full-line comments are dropped. */
function allowlistBodies(toml: string): string[] {
  const bodies: string[] = [];
  let current: string[] | undefined;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*$/.exec(line);
    if (header) {
      current = /allowlist/i.test(header[1] ?? '') ? [] : undefined;
      if (current) bodies.push('');
      continue;
    }
    if (current) bodies[bodies.length - 1] += `${line}\n`;
  }
  return bodies;
}

describe('SC-4 check scripts', () => {
  it('SC-4: check:fast, check:task and check:full equal the JSON block in CONSTRAINTS.md', () => {
    const block = /```json\r?\n([\s\S]*?)```/.exec(read('CONSTRAINTS.md'));
    expect(block).not.toBeNull();
    const expected = (JSON.parse(block?.[1] ?? '') as { scripts: Record<string, string> }).scripts;
    const actual = rootScripts();
    for (const name of ['check:fast', 'check:task', 'check:full']) {
      expect(expected[name], `${name} in CONSTRAINTS.md`).toBeTypeOf('string');
      expect(actual[name], `${name} in package.json`).toBe(expected[name]);
    }
  });

  it('SC-4: check:arch is the working architecture gate', () => {
    expect(rootScripts()['check:arch']).toBe('depcruise . --validate');
  });

  it('SC-4: .gitleaks.toml allowlists are path-scoped and match only the documented test DB URL', () => {
    expect(existsSync(path.join(root, '.gitleaks.toml'))).toBe(true);
    const bodies = allowlistBodies(read('.gitleaks.toml'));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, 'every allowlist needs a paths list').toMatch(/^\s*paths\s*=\s*\[/m);
      const regexes = /^\s*regexes\s*=\s*\[((?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\]'"])*)\]/m.exec(body)?.[1] ?? '';
      for (const m of regexes.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)) {
        // Escaped dots are fine; any other pattern (e.g. '.*') is a broad allowlist.
        expect((m[1] ?? m[2] ?? '').replace(/\\/g, '')).toBe(DB_URL);
      }
    }
  });
});
