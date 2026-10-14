import { describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/validate.js';
import type { Flow, FlowNode } from '../../src/types.js';

// GM-2, E_NESTING_DEPTH: frames nested deeper than 8. Pinned: the 9th nested frame fails, path = that frame's node pointer
// (`/nodes/f1/body/nodes/f2/.../body/nodes/f9`), exactly one error; 8 nested frames pass.

const str = { type: 'string' } as const;
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };

// n frames f1 > f2 > ... > fn, innermost holding a map.
const nested = (n: number): Flow => {
  let node: FlowNode = map;
  let id = 'm';
  for (let i = n; i >= 1; i--) {
    node = {
      kind: 'frame',
      frame: 'foreach',
      body: { nodes: { [id]: node }, edges: [], entry: { node: id, port: 'in' }, exit: { node: id, port: 'out' } },
      budgets: { maxIterations: 10, maxDurationMs: 1000 },
      concurrency: 1,
      in: str,
      out: str,
    };
    id = `f${i}`;
  }
  return { version: 1, id: 'f', name: 'f', nodes: { [id]: node }, edges: [] };
};

describe('GM-2: E_NESTING_DEPTH', () => {
  it('GM-2: E_NESTING_DEPTH 8 nested frames pass', () => {
    expect(validateFlow(nested(8)).ok).toBe(true);
  });

  it('GM-2: E_NESTING_DEPTH 9 nested frames fail at the 9th frame', () => {
    const r = validateFlow(nested(9));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const path = Array.from({ length: 9 }, (_v, i) => `/nodes/f${i + 1}`).join('/body');
    expect(r.errors.map((x) => [x.code, x.path, x.node])).toEqual([
      ['E_NESTING_DEPTH', path, 'f1.f2.f3.f4.f5.f6.f7.f8.f9'],
    ]);
  });
});
