import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../packages/graph/src/types.js';

// The only place that knows where the spec lives (it moves to docs/specs/ later).
const SPEC_PATH = new URL('../../SPEC-graph-model.md', import.meta.url);
const MARKER = 'Error codes (stable; additive only):';

/** Codes in the first cell of each row of the table right after MARKER; a row may list several, e.g. `E_A` / `E_B`. */
function tableCodes(markdown: string): string[] {
  const lines = markdown.split('\n').map((line) => line.trim());
  const start = lines.indexOf(MARKER);
  if (start < 0) throw new Error(`marker not found: ${MARKER}`);
  const after = lines.slice(start + 1);
  const first = after.findIndex((line) => line !== '');
  const end = after.findIndex((line, i) => i >= first && !line.startsWith('|'));
  return after
    .slice(first, end < 0 ? undefined : end)
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`(E_[A-Z0-9_]+)`/g)].map((m) => m[1] ?? ''));
}

describe('GM-2: spec table parser', () => {
  it('GM-2: reads one-code rows and `A` / `B` rows of the table after the marker only', () => {
    const md = [
      '| `E_BEFORE` | another table |',
      MARKER,
      '',
      '| Code | Raised when |',
      '|---|---|',
      '| `E_ONE` | uses `E_NOT_FIRST_CELL` |',
      '| `E_TWO` / `E_THREE` | both |',
      '',
      '| `E_AFTER` | another table |',
    ].join('\n');
    expect(tableCodes(md)).toEqual(['E_ONE', 'E_TWO', 'E_THREE']);
  });

  it('GM-2: fails loudly when the marker is missing', () => {
    expect(() => tableCodes('| `E_ONE` | x |')).toThrow(MARKER);
  });
});

describe('GM-2: spec sync', () => {
  it('GM-2: ErrorCode union and the SPEC-graph-model.md error table list the same codes', () => {
    const fromSpec = tableCodes(readFileSync(SPEC_PATH, 'utf8'));

    expect(fromSpec.length).toBeGreaterThanOrEqual(11);
    expect(fromSpec, 'ERROR_CODES must equal the spec table, in spec order').toEqual([...ERROR_CODES]);
  });
});
