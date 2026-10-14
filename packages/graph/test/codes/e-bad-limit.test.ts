import { describe, expect, it } from 'vitest';
import { validateWired } from '../helpers.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-2, E_BAD_LIMIT: map/sink `concurrency` present but not a positive integer; foreach `concurrency` absent or invalid;
// retry `maxAttempts` absent/non-integer/non-number (a number < 1 is E_MISSING_EXIT, never both); retry `backoff.baseMs`
// absent, non-number or negative. path = `.../concurrency`, `.../maxAttempts`, `.../backoff/baseMs`.

const str = { type: 'string' } as const;
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const sink: FlowNode = { kind: 'sink', fn: 'f', in: str };
const e = (from: string, to: string): Edge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
});
const budgets = { maxIterations: 10, maxDurationMs: 1000 };
const frame = (
  kind: string,
  extra: Record<string, unknown>,
  nodes: Record<string, FlowNode> = { x: map, y: map },
): FlowNode =>
  ({
    kind: 'frame',
    frame: kind,
    body: {
      nodes,
      edges: [e('x', 'y')],
      entry: { node: 'x', port: 'in' },
      exit: { node: 'y', port: 'out' },
    },
    budgets,
    in: str,
    out: str,
    ...extra,
  }) as FlowNode;
const foreach = (concurrency: unknown): FlowNode =>
  frame('foreach', { concurrency });
const retry = (extra: Record<string, unknown>): FlowNode =>
  frame('retry', {
    maxAttempts: 3,
    backoff: { kind: 'fixed', baseMs: 10 },
    onExhausted: 'fail-run',
    ...extra,
  });
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
const withProp = (n: FlowNode, k: string, v: unknown): FlowNode =>
  ({ ...n, [k]: v }) as FlowNode;

describe('GM-2: E_BAD_LIMIT', () => {
  const rows: [string, Flow, string][] = [
    [
      'foreach concurrency absent',
      flow({ f: foreach(undefined) }),
      '/nodes/f/concurrency',
    ],
    ['foreach concurrency 0', flow({ f: foreach(0) }), '/nodes/f/concurrency'],
    [
      'foreach concurrency 1.5',
      flow({ f: foreach(1.5) }),
      '/nodes/f/concurrency',
    ],
    [
      'map concurrency 0',
      flow({ m: withProp(map, 'concurrency', 0) }),
      '/nodes/m/concurrency',
    ],
    [
      'map concurrency 1.5',
      flow({ m: withProp(map, 'concurrency', 1.5) }),
      '/nodes/m/concurrency',
    ],
    [
      'sink concurrency -1',
      flow({ k: withProp(sink, 'concurrency', -1) }),
      '/nodes/k/concurrency',
    ],
    [
      'sink concurrency not a number',
      flow({ k: withProp(sink, 'concurrency', '2') }),
      '/nodes/k/concurrency',
    ],
    [
      'retry maxAttempts absent',
      flow({ f: retry({ maxAttempts: undefined }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'retry maxAttempts 1.5',
      flow({ f: retry({ maxAttempts: 1.5 }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'retry maxAttempts NaN',
      flow({ f: retry({ maxAttempts: Number.NaN }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'retry maxAttempts not a number',
      flow({ f: retry({ maxAttempts: '3' }) }),
      '/nodes/f/maxAttempts',
    ],
    [
      'retry baseMs negative',
      flow({ f: retry({ backoff: { kind: 'fixed', baseMs: -1 } }) }),
      '/nodes/f/backoff/baseMs',
    ],
    [
      'retry baseMs absent',
      flow({ f: retry({ backoff: { kind: 'fixed' } }) }),
      '/nodes/f/backoff/baseMs',
    ],
    [
      'retry baseMs NaN',
      flow({ f: retry({ backoff: { kind: 'fixed', baseMs: Number.NaN } }) }),
      '/nodes/f/backoff/baseMs',
    ],
    [
      'retry baseMs Infinity',
      flow({
        f: retry({
          backoff: { kind: 'fixed', baseMs: Number.POSITIVE_INFINITY },
        }),
      }),
      '/nodes/f/backoff/baseMs',
    ],
    [
      'retry baseMs not a number',
      flow({ f: retry({ backoff: { kind: 'fixed', baseMs: '10' } }) }),
      '/nodes/f/backoff/baseMs',
    ],
    [
      'a nested foreach is checked with its scope-prefixed path',
      flow({
        f: frame(
          'while',
          { condition: 'c' },
          { x: map, y: map, g: foreach(0) },
        ),
      }),
      '/nodes/f/body/nodes/g/concurrency',
    ],
  ];

  it.each(rows)('GM-2: E_BAD_LIMIT %s', (_name, f, path) => {
    expect(errs(f)).toEqual([['E_BAD_LIMIT', path]]);
  });

  it('GM-2: E_BAD_LIMIT valid limits pass, and map/sink concurrency may be absent', () => {
    const ok = (nodes: Record<string, FlowNode>) =>
      expect(validateWired(flow(nodes)).ok).toBe(true);
    ok({ f: foreach(4), r: retry({}), m: map, k: sink });
    ok({
      m: withProp(map, 'concurrency', 2),
      k: withProp(sink, 'concurrency', 1),
    });
    ok({ r: retry({ backoff: { kind: 'exponential', baseMs: 0 } }) });
  });
});
