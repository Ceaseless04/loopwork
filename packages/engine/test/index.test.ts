import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('@loopwork/engine package scaffold', () => {
  it('is a workspace package whose entry module loads', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string };
    expect(pkg.name).toBe('@loopwork/engine');
    expect(typeof (await import('../src/index.js'))).toBe('object');
  });
});
