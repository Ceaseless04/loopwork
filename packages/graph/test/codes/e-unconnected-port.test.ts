import { describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/validate.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-2, E_UNCONNECTED_PORT: a required input (map.in, sink.in, frame in) with no incoming edge in its scope.
// path = `<scope>/nodes/<id>`, node = scoped id. A body's entry node is fed by the frame boundary; unconnected outputs are fine.

const str = { type: 'string' } as const;
const src: FlowNode = { kind: 'source', fn: 'f', out: str };
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const sink: FlowNode = { kind: 'sink', fn: 'f', in: str };
const budgets = { maxIterations: 10, maxDurationMs: 1000 };
const e = (from: string, to: string): Edge => ({ from: { node: from, port: 'out' }, to: { node: to, port: 'in' } });
// foreach frame whose body is `nodes` (entry and exit both `x`).
const frame = (nodes: Record<string, FlowNode>, edges: Edge[] = []): FlowNode => ({
  kind: 'frame',
  frame: 'foreach',
  body: { nodes, edges, entry: { node: 'x', port: 'in' }, exit: { node: 'x', port: 'out' } },
  budgets,
  concurrency: 1,
  in: str,
  out: str,
});
const flow = (nodes: Record<string, FlowNode>, edges: Edge[]): Flow => ({ version: 1, id: 'f', name: 'f', nodes, edges });

describe('GM-2: E_UNCONNECTED_PORT', () => {
  // Each flow is otherwise fully wired; `a` (or a dropped `m.out`) also shows that unconnected outputs are not errors.
  const rows: [string, Flow, string, string][] = [
    ['map.in', flow({ a: src, m: map, s: sink }, [e('m', 's')]), '/nodes/m', 'm'],
    ['sink.in', flow({ a: src, m: map, s: sink }, [e('a', 'm')]), '/nodes/s', 's'],
    ['frame in', flow({ a: src, f: frame({ x: map }), s: sink }, [e('f', 's')]), '/nodes/f', 'f'],
    ['nested frame in', flow({ a: src, f: frame({ x: map, g: frame({ x: map }) }), s: sink }, [e('a', 'f'), e('f', 's')]), '/nodes/f/body/nodes/g', 'f.g'],
    ['a non-entry map in a body', flow({ a: src, f: frame({ x: map, y: map }), s: sink }, [e('a', 'f'), e('f', 's')]), '/nodes/f/body/nodes/y', 'f.y'],
  ];

  it.each(rows)('GM-2: E_UNCONNECTED_PORT %s', (_name, f, path, node) => {
    const r = validateFlow(f);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path, x.node])).toEqual([['E_UNCONNECTED_PORT', path, node]]);
  });

  // The message names the node by its scoped id (the same id `node` carries), not the bare body-local key.
  it('GM-2: E_UNCONNECTED_PORT message uses the scoped node id', () => {
    const r = validateFlow(flow({ a: src, f: frame({ x: map, y: map }), s: sink }, [e('a', 'f'), e('f', 's')]));
    if (r.ok) throw new Error('expected errors');
    expect(r.errors.map((x) => [x.node, x.message])).toEqual([['f.y', 'input port "in" of node "f.y" has no incoming edge']]);
  });

  // An edge into a port that does not exist (or points the wrong way) does not feed the node.
  it('GM-2: E_UNCONNECTED_PORT an edge into an unknown port does not feed the node', () => {
    const edge: Edge = { from: { node: 'a', port: 'out' }, to: { node: 'm', port: 'nope' } };
    const r = validateFlow(flow({ a: src, m: map, s: sink }, [edge, e('m', 's')]));
    if (r.ok) throw new Error('expected errors');
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([
      ['E_UNKNOWN_PORT', '/edges/0/to/port'],
      ['E_UNCONNECTED_PORT', '/nodes/m'],
    ]);
  });

  it('GM-2: E_UNCONNECTED_PORT is checked per scope: the same id fed in the outer scope is unfed in a body', () => {
    const r = validateFlow(flow({ a: src, m: map, f: frame({ x: map, m: map }), s: sink }, [e('a', 'm'), e('a', 'f'), e('f', 's')]));
    if (r.ok) throw new Error('expected errors');
    expect(r.errors.map((x) => [x.code, x.path, x.node])).toEqual([['E_UNCONNECTED_PORT', '/nodes/f/body/nodes/m', 'f.m']]);
  });

  it('GM-2: E_UNCONNECTED_PORT a body exit node with no incoming edge is reported, the entry node is not', () => {
    const body = { nodes: { x: map, y: map }, edges: [], entry: { node: 'x', port: 'in' }, exit: { node: 'y', port: 'out' } };
    const f: FlowNode = { kind: 'frame', frame: 'foreach', body, budgets, concurrency: 1, in: str, out: str };
    const r = validateFlow(flow({ a: src, f, s: sink }, [e('a', 'f'), e('f', 's')]));
    if (r.ok) throw new Error('expected errors');
    // no path entry -> exit, so E_MISSING_EXIT also fires; sorted by path
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([
      ['E_MISSING_EXIT', '/nodes/f/body/exit'],
      ['E_UNCONNECTED_PORT', '/nodes/f/body/nodes/y'],
    ]);
  });

  it('GM-2: E_UNCONNECTED_PORT a body entry node is fed by the frame boundary, not unconnected', () => {
    expect(validateFlow(flow({ a: src, f: frame({ x: map }), s: sink }, [e('a', 'f'), e('f', 's')])).ok).toBe(true);
  });

  it('GM-2: E_UNCONNECTED_PORT a dropped output is allowed', () => {
    expect(validateFlow(flow({ a: src, m: map }, [e('a', 'm')])).ok).toBe(true);
  });
});
