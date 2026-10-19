import { describe, expect, it } from 'vitest';
import { validateWired } from '../helpers.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-3 / GM-2, E_MISSING_BUDGET: a frame's budgets.maxIterations / maxDurationMs is absent or not a positive integer.
// path = `<scope>/nodes/<frame>/budgets/<field>`. maxCostUsd / maxTokens are optional and not checked beyond being carried.

const str = { type: 'string' } as const;
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const e = (from: string, to: string): Edge => ({
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
});
const frame = (
  budgets: unknown,
  nodes: Record<string, FlowNode> = { x: map, y: map },
): FlowNode =>
  ({
    kind: 'frame',
    frame: 'while',
    body: {
      nodes,
      edges: [e('x', 'y')],
      entry: { node: 'x', port: 'in' },
      exit: { node: 'y', port: 'out' },
    },
    budgets,
    condition: 'c',
    in: str,
    out: str,
  }) as FlowNode;
const flow = (nodes: Record<string, FlowNode>): Flow => ({
  version: 1,
  id: 'f',
  name: 'f',
  nodes,
  edges: [],
});
const good = { maxIterations: 10, maxDurationMs: 1000 };

const errs = (f: Flow) => {
  const r = validateWired(f);
  return r.ok ? [] : r.errors.map((x) => [x.code, x.path]);
};

describe('GM-3: budgets are mandatory on every frame', () => {
  const bad: [string, unknown][] = [
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['a string', '5'],
  ];
  const rows: [string, Flow, string][] = (
    ['maxIterations', 'maxDurationMs'] as const
  ).flatMap((field) => {
    const without = { ...good, [field]: undefined };
    return [
      [
        `GM-3: a frame missing ${field} fails with E_MISSING_BUDGET`,
        flow({ f: frame(without) }),
        field,
      ] as [string, Flow, string],
      ...bad.map(
        ([label, v]) =>
          [
            `GM-3: ${field} of ${label} fails with E_MISSING_BUDGET`,
            flow({ f: frame({ ...good, [field]: v }) }),
            field,
          ] as [string, Flow, string],
      ),
    ];
  });

  it.each(rows)('%s', (_name, f, field) => {
    expect(errs(f)).toEqual([
      ['E_MISSING_BUDGET', `/nodes/f/budgets/${field}`],
    ]);
  });

  it('GM-3: the same flow with budgets passes', () => {
    expect(validateWired(flow({ f: frame(good) })).ok).toBe(true);
  });

  it('GM-3: both budgets missing reports one error per field', () => {
    expect(errs(flow({ f: frame({}) }))).toEqual([
      ['E_MISSING_BUDGET', '/nodes/f/budgets/maxDurationMs'],
      ['E_MISSING_BUDGET', '/nodes/f/budgets/maxIterations'],
    ]);
  });

  it('GM-2: E_MISSING_BUDGET a nested frame is checked with its scope-prefixed path', () => {
    const f = flow({
      f: frame(good, { x: map, y: map, g: frame({ maxIterations: 10 }) }),
    });
    expect(errs(f)).toEqual([
      ['E_MISSING_BUDGET', '/nodes/f/body/nodes/g/budgets/maxDurationMs'],
    ]);
  });

  it('GM-2: E_MISSING_BUDGET a nested frame error carries the scoped node id', () => {
    const f = flow({
      f: frame(good, { x: map, y: map, g: frame({ maxIterations: 10 }) }),
    });
    const r = validateWired(f);
    expect(r.ok ? [] : r.errors.map((x) => x.node)).toEqual(['f.g']);
  });

  it('GM-3: optional maxCostUsd and maxTokens are accepted and carried', () => {
    const f = flow({ f: frame({ ...good, maxCostUsd: 0.5, maxTokens: 1000 }) });
    const r = validateWired(f);
    expect(r.ok).toBe(true);
    expect(r.ok && r.flow.nodes.f).toMatchObject({
      budgets: { maxCostUsd: 0.5, maxTokens: 1000 },
    });
  });
});
