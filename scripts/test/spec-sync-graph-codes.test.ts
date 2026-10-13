import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../packages/graph/src/types.js';

// The only place that knows where the spec lives (it moves to docs/specs/ later).
const SPEC_PATH = new URL('../../SPEC-graph-model.md', import.meta.url);

/** Codes in the first cell of every `| ... |` row; a row may list several, e.g. `E_A` / `E_B`. Header and separator rows hold none. */
function tableCodes(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`(E_[A-Z0-9_]+)`/g)].map((m) => m[1] ?? ''));
}

const missingFrom = (have: readonly string[], want: readonly string[]): string[] => want.filter((c) => !have.includes(c));

describe('GM-2: spec table parser', () => {
  it('GM-2: reads one-code rows and `A` / `B` rows, and ignores header, separator and other text', () => {
    const md = ['prose with `E_IGNORED` in it', '| Code | Raised when |', '|---|---|', '| `E_ONE` | uses `E_NOT_FIRST_CELL` |', '| `E_TWO` / `E_THREE` | both |'].join('\n');
    expect(tableCodes(md)).toEqual(['E_ONE', 'E_TWO', 'E_THREE']);
  });

  it('GM-2: a code added on either side is reported as a difference', () => {
    expect(missingFrom(['E_A'], ['E_A', 'E_B'])).toEqual(['E_B']);
    expect(missingFrom(['E_A', 'E_B'], ['E_A'])).toEqual([]);
  });
});

describe('GM-2: spec sync', () => {
  it('GM-2: ErrorCode union and the SPEC-graph-model.md error table list the same codes', () => {
    const fromSpec = tableCodes(readFileSync(SPEC_PATH, 'utf8'));

    expect(fromSpec.length).toBeGreaterThanOrEqual(11);
    expect(new Set(fromSpec).size).toBe(fromSpec.length);
    expect(missingFrom(ERROR_CODES, fromSpec), 'in the spec table but not in ERROR_CODES').toEqual([]);
    expect(missingFrom(fromSpec, ERROR_CODES), 'in ERROR_CODES but not in the spec table').toEqual([]);
  });
});
