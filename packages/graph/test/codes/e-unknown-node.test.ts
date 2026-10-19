import { describe, expect, it } from 'vitest';
import { validateWired } from '../helpers.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-2, E_UNKNOWN_NODE: an edge endpoint names a node that is not in the scope. path = `<scope>/edges/<i>/<from|to>/node`;
// outer-scope errors carry `edge` = edgeId(edge). Body edges address body nodes by their id within the body.

const str = { type: 'string' } as const;
const src: FlowNode = { kind: 'source', fn: 'f', out: str };
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const sink: FlowNode = { kind: 'sink', fn: 'f', in: str };
const e = (fn: string, fp: string, tn: string, tp: string): Edge => ({ from: { node: fn, port: fp }, to: { node: tn, port: tp } });
const outer = (edges: Edge[]): Flow => ({ version: 1, id: 'f', name: 'f', nodes: { a: src, b: sink }, edges });
const inBody = (edges: Edge[], entry = { node: 'x', port: 'in' }, exit = { node: 'y', port: 'out' }): Flow => ({
  version: 1,
  id: 'f',
  name: 'f',
  nodes: {
    f: {
      kind: 'frame',
      frame: 'foreach',
      body: { nodes: { x: map, y: map }, edges, entry, exit },
      budgets: { maxIterations: 10, maxDurationMs: 1000 },
      concurrency: 1,
      in: str,
      out: str,
    },
  },
  edges: [],
});

describe('GM-2: E_UNKNOWN_NODE', () => {
  // [name, flow, path, edge, node]. Endpoint errors carry node = the referenced id scoped to its scope; a body edge id is
  // edgeId with BOTH node ids scoped by the frame prefix.
  const rows: [string, Flow, string, string, string | undefined][] = [
    ['outer from', outer([e('zz', 'out', 'b', 'in')]), '/edges/0/from/node', 'zz.out->b.in', 'zz'],
    ['outer to', outer([e('a', 'out', 'zz', 'in')]), '/edges/0/to/node', 'a.out->zz.in', 'zz'],
    ['outer to Object.prototype name', outer([e('a', 'out', 'toString', 'in')]), '/edges/0/to/node', 'a.out->toString.in', 'toString'],
    ['body from', inBody([e('zz', 'out', 'y', 'in'), e('x', 'out', 'y', 'in')]), '/nodes/f/body/edges/0/from/node', 'f.zz.out->f.y.in', 'f.zz'],
    ['body to', inBody([e('x', 'out', 'zz', 'in'), e('x', 'out', 'y', 'in')]), '/nodes/f/body/edges/0/to/node', 'f.x.out->f.zz.in', 'f.zz'],
    ['body entry', inBody([], { node: 'zz', port: 'in' }), '/nodes/f/body/entry/node', '', undefined],
    ['body exit', inBody([], undefined, { node: 'zz', port: 'out' }), '/nodes/f/body/exit/node', '', undefined],
  ];

  it.each(rows)('GM-2: E_UNKNOWN_NODE %s', (_name, flow, path, edge, node) => {
    const r = validateWired(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_UNKNOWN_NODE', path]]);
    if (edge !== '') expect(r.errors[0]?.edge).toBe(edge);
    if (node !== undefined) expect(r.errors[0]?.node).toBe(node);
  });

  it('GM-2: E_UNKNOWN_NODE valid edges pass, in the outer scope and in a body', () => {
    expect(validateWired(outer([e('a', 'out', 'b', 'in')])).ok).toBe(true);
    expect(validateWired(inBody([e('x', 'out', 'y', 'in')])).ok).toBe(true);
  });

  it('GM-2: E_UNKNOWN_NODE both endpoints missing reports both', () => {
    const r = validateWired(outer([e('p', 'out', 'q', 'in')]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([
      ['E_UNKNOWN_NODE', '/edges/0/from/node'],
      ['E_UNKNOWN_NODE', '/edges/0/to/node'],
    ]);
  });
});
