import { describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/validate.js';
import type { Edge, Flow, FlowNode, PortSpec } from '../../src/types.js';

// GM-2, E_SHAPE: a port that still has `inferFrom` reached validateFlow (parseFlow resolves it). path = `<scope>/nodes/<id>/<in|out>`;
// type checks involving that port are skipped, so there is exactly one error.

const str = { type: 'string' } as const;
const unresolved: PortSpec = { inferFrom: ['x'] };
const e = (from: string, to: string): Edge => ({ from: { node: from, port: 'out' }, to: { node: to, port: 'in' } });

describe('GM-2: E_SHAPE unresolved inferFrom', () => {
  const rows: [string, Record<string, FlowNode>, string][] = [
    ['source out', { a: { kind: 'source', fn: 'f', out: unresolved }, s: { kind: 'sink', fn: 'f', in: { type: 'number' } } }, '/nodes/a/out'],
    ['sink in', { a: { kind: 'source', fn: 'f', out: str }, s: { kind: 'sink', fn: 'f', in: unresolved } }, '/nodes/s/in'],
  ];

  it.each(rows)('GM-2: E_SHAPE unresolved inferFrom on %s skips the type check', (_name, nodes, path) => {
    const flow: Flow = { version: 1, id: 'f', name: 'f', nodes, edges: [e('a', 's')] };
    const r = validateFlow(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_SHAPE', path]]);
    expect(r.errors[0]?.message).toMatch(/unresolved inferFrom/);
  });
});
