import { describe, expect, it } from 'vitest';
import { portsOf } from '../../src/walk.js';
import { validateWired } from '../helpers.js';
import type { Edge, Flow, FlowNode } from '../../src/types.js';

// GM-2, E_UNKNOWN_PORT: an edge endpoint names a port the node kind does not have. path = `<scope>/edges/<i>/<from|to>/port`.
// Port rules: source out; map in,out; sink in; frames in,out, plus error only for retry with onExhausted 'emit-error'.

const str = { type: 'string' } as const;
const src: FlowNode = { kind: 'source', fn: 'f', out: str };
const map: FlowNode = { kind: 'map', fn: 'f', in: str, out: str };
const sink: FlowNode = { kind: 'sink', fn: 'f', in: str };
const budgets = { maxIterations: 10, maxDurationMs: 1000 };
const body = { nodes: { m: map }, edges: [], entry: { node: 'm', port: 'in' }, exit: { node: 'm', port: 'out' } };
const foreach: FlowNode = { kind: 'frame', frame: 'foreach', body, budgets, concurrency: 1, in: str, out: str };
const retry = (onExhausted: 'fail-run' | 'emit-error'): FlowNode => ({
  kind: 'frame',
  frame: 'retry',
  body,
  budgets,
  maxAttempts: 3,
  backoff: { kind: 'fixed', baseMs: 10 },
  onExhausted,
  in: str,
  out: str,
});
const e = (fn: string, fp: string, tn: string, tp: string): Edge => ({ from: { node: fn, port: fp }, to: { node: tn, port: tp } });
const flowOf = (nodes: Record<string, FlowNode>, edges: Edge[]): Flow => ({ version: 1, id: 'f', name: 'f', nodes, edges });

describe('GM-2: E_UNKNOWN_PORT', () => {
  it.each<[string, FlowNode, { in: boolean; out: boolean; error: boolean }]>([
    ['source', src, { in: false, out: true, error: false }],
    ['map', map, { in: true, out: true, error: false }],
    ['sink', sink, { in: true, out: false, error: false }],
    ['foreach', foreach, { in: true, out: true, error: false }],
    ['retry fail-run', retry('fail-run'), { in: true, out: true, error: false }],
    ['retry emit-error', retry('emit-error'), { in: true, out: true, error: true }],
  ])('GM-2: E_UNKNOWN_PORT portsOf %s', (_name, node, ports) => {
    expect(portsOf(node)).toEqual(ports);
  });

  const nodes = { a: src, a2: src, m: map, s: sink, fe: foreach, r: retry('fail-run'), re: retry('emit-error') };
  const rows: [string, Edge, string][] = [
    ['sink.out as from', e('s', 'out', 'm', 'in'), '/edges/0/from/port'],
    ['source.in as to', e('a', 'out', 'a2', 'in'), '/edges/0/to/port'],
    ['retry.error without emit-error', e('r', 'error', 's', 'in'), '/edges/0/from/port'],
    ['foreach.error', e('fe', 'error', 's', 'in'), '/edges/0/from/port'],
    ['Object.prototype port name', e('a', 'toString', 's', 'in'), '/edges/0/from/port'],
    ['made-up port name', e('a', 'nope', 's', 'in'), '/edges/0/from/port'],
  ];

  it.each(rows)('GM-2: E_UNKNOWN_PORT %s', (_name, edge, path) => {
    const r = validateWired(flowOf(nodes, [edge]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_UNKNOWN_PORT', path]]);
    expect(r.errors[0]?.edge).toBe(`${edge.from.node}.${edge.from.port}->${edge.to.node}.${edge.to.port}`);
  });

  it('GM-2: E_UNKNOWN_PORT retry.error with emit-error is a known port', () => {
    // the error port carries {message,item}, so the receiving sink must accept it (an untyped sink does)
    const anySink: FlowNode = { kind: 'sink', fn: 'f', in: {} };
    expect(validateWired(flowOf({ ...nodes, s: anySink }, [e('re', 'error', 's', 'in')])).ok).toBe(true);
  });
});

// Direction: an edge `from` must be an output port and `to` the input port; a port that exists but points the wrong way is
// E_UNKNOWN_PORT too (message says the direction is wrong). Each flow is otherwise fully wired, so this is the only error.
describe('GM-2: E_UNKNOWN_PORT port direction', () => {
  const direction = (extra: Edge, retryNode: FlowNode = retry('fail-run')): Flow =>
    flowOf(
      { a: src, a2: src, m: map, s: sink, r: retryNode },
      [e('a', 'out', 'm', 'in'), e('m', 'out', 's', 'in'), e('a2', 'out', 'r', 'in'), extra],
    );
  const FROM = "an edge's from port must be an output port";
  const TO = "an edge's to port must be the input port";
  const rows: [string, Flow, string, string][] = [
    ['map.in as from', direction(e('m', 'in', 's', 'in')), '/edges/3/from/port', FROM],
    ['source.out as to', direction(e('a', 'out', 'a2', 'out')), '/edges/3/to/port', TO],
    ['retry.error as to', direction(e('a', 'out', 'r', 'error'), retry('emit-error')), '/edges/3/to/port', TO],
  ];

  it.each(rows)('GM-2: E_UNKNOWN_PORT direction %s', (_name, flow, path, text) => {
    const r = validateWired(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_UNKNOWN_PORT', path]]);
    expect(r.errors[0]?.edge).toBeDefined();
    expect(r.errors[0]?.message).toContain(text);
  });
});

describe('GM-2: E_UNKNOWN_PORT body edges and boundary refs', () => {
  const inBody = (
    edges: Edge[],
    entry = { node: 'x', port: 'in' },
    exit = { node: 'y', port: 'out' },
  ): Flow =>
    flowOf(
      { f: { kind: 'frame', frame: 'foreach', body: { nodes: { x: map, y: map }, edges, entry, exit }, budgets, concurrency: 1, in: str, out: str } },
      [],
    );

  it('GM-2: E_UNKNOWN_PORT body edge carries the scoped edge id and node', () => {
    const r = validateWired(inBody([e('x', 'nope', 'y', 'in')]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path, x.edge, x.node])).toEqual([
      ['E_UNKNOWN_PORT', '/nodes/f/body/edges/0/from/port', 'f.x.nope->f.y.in', 'f.x'],
    ]);
  });

  // entry must be an input port ('in'), exit an output port ('out'): a port that exists but points the wrong way is unknown too.
  it.each<[string, Flow, string]>([
    ['body entry port out', inBody([e('x', 'out', 'y', 'in')], { node: 'x', port: 'out' }), '/nodes/f/body/entry/port'],
    ['body exit port in', inBody([e('x', 'out', 'y', 'in')], undefined, { node: 'y', port: 'in' }), '/nodes/f/body/exit/port'],
  ])('GM-2: E_UNKNOWN_PORT %s', (_name, flow, path) => {
    const r = validateWired(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_UNKNOWN_PORT', path]]);
  });
});
