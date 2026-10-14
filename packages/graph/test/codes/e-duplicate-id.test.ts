import { describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/validate.js';
import type { Flow, FlowNode } from '../../src/types.js';

// GM-2, E_DUPLICATE_ID. Node ids are record keys, so a literal duplicate cannot exist; the code applies to ids that
// break the scoped-id namespace: an id containing '.' (scopedId/edgeId would collide) or '->' (edgeId would collide).
// Checked at EVERY scope, body nodes included. path = `<scope>/nodes/<id>`, node = scoped id.

const str = { type: 'string' } as const;
const src: FlowNode = { kind: 'source', fn: 'f', out: str };
const body = (nodes: Record<string, FlowNode>, id: string) => ({
  nodes,
  edges: [],
  entry: { node: id, port: 'in' },
  exit: { node: id, port: 'out' },
});
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const frame = (nodes: Record<string, FlowNode>, id: string): FlowNode => ({
  kind: 'frame',
  frame: 'foreach',
  body: body(nodes, id),
  budgets: { maxIterations: 10, maxDurationMs: 1000 },
  concurrency: 1,
  in: str,
  out: str,
});
const flowOf = (nodes: Record<string, FlowNode>): Flow => ({ version: 1, id: 'f', name: 'f', nodes, edges: [] });

describe('GM-2: E_DUPLICATE_ID', () => {
  const rows: [string, Flow, string, string][] = [
    ['id containing "." in the outer scope', flowOf({ 'a.b': src }), '/nodes/a.b', 'a.b'],
    ['id containing "/" and "." (pointer-escaped)', flowOf({ 'a/b.c': src }), '/nodes/a~1b.c', 'a/b.c'],
    ['id containing "~" and "." (pointer-escaped)', flowOf({ 'a~b.c': src }), '/nodes/a~0b.c', 'a~b.c'],
    ['id containing "->" in the outer scope', flowOf({ 'a->b': src }), '/nodes/a->b', 'a->b'],
    ['id containing "." in a body', flowOf({ f: frame({ 'x.y': map }, 'x.y') }), '/nodes/f/body/nodes/x.y', 'f.x.y'],
  ];

  it.each(rows)('GM-2: E_DUPLICATE_ID %s', (_name, flow, path, node) => {
    const r = validateFlow(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => [e.code, e.path, e.node])).toEqual([['E_DUPLICATE_ID', path, node]]);
    expect(r.errors[0]?.message).toMatch(/\.|->/);
  });

  it('GM-2: E_DUPLICATE_ID dot-free ids at every scope pass', () => {
    expect(validateFlow(flowOf({ a: src, f: frame({ a: map }, 'a') })).ok).toBe(true);
  });
});
