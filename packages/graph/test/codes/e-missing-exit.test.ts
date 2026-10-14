import { describe, expect, it } from 'vitest';
import { validateWired } from '../helpers.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-2, E_MISSING_EXIT: while/until without a condition (path `.../condition`), retry with maxAttempts < 1
// (`.../maxAttempts`), or a body with no path from entry to exit (`<frame>/body/exit`). Exactly one error per problem.

const str = { type: 'string' } as const;
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const e = (from: string, to: string): Edge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
});
const budgets = { maxIterations: 10, maxDurationMs: 1000 };
const retry = {
  maxAttempts: 3,
  backoff: { kind: 'fixed', baseMs: 10 },
  onExhausted: 'fail-run',
};
const frame = (
  kind: string,
  extra: Record<string, unknown>,
  body: {
    nodes?: Record<string, FlowNode>;
    edges?: Edge[];
    entry?: string;
    exit?: string;
  } = {},
): FlowNode =>
  ({
    kind: 'frame',
    frame: kind,
    body: {
      nodes: body.nodes ?? { x: map, y: map },
      edges: body.edges ?? [e('x', 'y')],
      entry: { node: body.entry ?? 'x', port: 'in' },
      exit: { node: body.exit ?? 'y', port: 'out' },
    },
    budgets,
    in: str,
    out: str,
    ...extra,
  }) as FlowNode;
const flow = (nodes: Record<string, FlowNode>): Flow => ({
  version: 1,
  id: 'f',
  name: 'f',
  nodes,
  edges: [],
});
const errs = (f: Flow) => {
  const r = validateWired(f);
  return r.ok ? [] : r.errors.map((x) => [x.code, x.path]);
};

describe('GM-2: E_MISSING_EXIT', () => {
  const rows: [string, Flow, string][] = [
    [
      'while without a condition',
      flow({ f: frame('while', {}) }),
      '/nodes/f/condition',
    ],
    [
      'until with an empty condition',
      flow({ f: frame('until', { condition: '' }) }),
      '/nodes/f/condition',
    ],
    [
      'retry with maxAttempts 0',
      flow({ f: frame('retry', { ...retry, maxAttempts: 0 }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'retry with maxAttempts -1',
      flow({ f: frame('retry', { ...retry, maxAttempts: -1 }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'a body with no path from entry to exit',
      flow({ f: frame('while', { condition: 'c' }, { edges: [] }) }),
      '/nodes/f/body/exit',
    ],
    [
      'a body whose edges run the wrong way',
      flow({ f: frame('while', { condition: 'c' }, { edges: [e('y', 'x')] }) }),
      '/nodes/f/body/exit',
    ],
    [
      'a nested frame is checked with its scope-prefixed path',
      flow({
        f: frame(
          'while',
          { condition: 'c' },
          {
            nodes: { x: map, y: map, g: frame('while', {}) },
            edges: [e('x', 'y')],
          },
        ),
      }),
      '/nodes/f/body/nodes/g/condition',
    ],
  ];

  it.each(rows)('GM-2: E_MISSING_EXIT %s', (_name, f, path) => {
    expect(errs(f)).toEqual([['E_MISSING_EXIT', path]]);
  });

  it('GM-2: E_MISSING_EXIT an unreachable exit behind a body cycle reports and terminates', () => {
    const f = flow({
      f: frame(
        'while',
        { condition: 'c' },
        {
          nodes: { x: map, y: map, z: map },
          edges: [e('x', 'z'), e('z', 'x')],
        },
      ),
    });
    expect(errs(f)).toEqual([
      ['E_CYCLE', '/nodes/f/body'],
      ['E_MISSING_EXIT', '/nodes/f/body/exit'],
    ]);
  });

  it('GM-2: E_MISSING_EXIT valid exits pass: condition, maxAttempts 1, multi-hop path, entry == exit', () => {
    const ok = (f: FlowNode) => expect(validateWired(flow({ f })).ok).toBe(true);
    ok(frame('while', { condition: 'c' }));
    ok(frame('retry', { ...retry, maxAttempts: 1 }));
    ok(
      frame(
        'until',
        { condition: 'c' },
        {
          nodes: { x: map, m: map, y: map },
          edges: [e('x', 'm'), e('m', 'y')],
        },
      ),
    );
    ok(
      frame(
        'while',
        { condition: 'c' },
        { nodes: { x: map }, edges: [], entry: 'x', exit: 'x' },
      ),
    );
  });
});
