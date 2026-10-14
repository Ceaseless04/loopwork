import { describe, expect, it } from 'vitest';
import { validateFlow } from '../../src/validate.js';
import type { Edge, Flow, FlowNode, PortSpec } from '../../src/types.js';

// GM-2 (E_TYPE_MISMATCH) and GM-5. Edge mismatch: path `<scope>/edges/<i>` with `edge` set. Frame boundary: `<frame>/body/entry`
// (frame.in -> entry port) and `<frame>/body/exit` (exit port -> frame.out). while/until state loop: `<frame>/body`.
// ADR 0004: `{}` -> `{}` and `X` -> `{}` pass; `{}` -> typed is a mismatch whose message tells the author to type the producer.

const str: PortSpec = { type: 'string' };
const num: PortSpec = { type: 'number' };
const int: PortSpec = { type: 'integer' };
const any: PortSpec = {};
const budgets = { maxIterations: 10, maxDurationMs: 1000 };
const e = (from: string, fp: string, to: string, tp: string): Edge => ({ from: { node: from, port: fp }, to: { node: to, port: tp } });
const errs = (f: Flow) => {
  const r = validateFlow(f);
  return r.ok ? [] : r.errors.map((x) => [x.code, x.path]);
};

// source(from) -> sink(to): the smallest flow with one edge to type-check.
const direct = (from: PortSpec, to: PortSpec): Flow => ({
  version: 1,
  id: 'f',
  name: 'f',
  nodes: { a: { kind: 'source', fn: 'f', out: from }, s: { kind: 'sink', fn: 'f', in: to } },
  edges: [e('a', 'out', 's', 'in')],
});

// source(fin) -> frame f(in fin, out fout) -> sink(fout); the body is one map `x` (entry and exit) with ports xin/xout.
const framed = (kind: 'foreach' | 'while' | 'until', fin: PortSpec, fout: PortSpec, xin: PortSpec, xout: PortSpec): Flow => {
  const body = { nodes: { x: { kind: 'map', fn: 'f', in: xin, out: xout } as FlowNode }, edges: [], entry: { node: 'x', port: 'in' }, exit: { node: 'x', port: 'out' } };
  const frame = (
    kind === 'foreach'
      ? { kind: 'frame', frame: 'foreach', body, budgets, concurrency: 1, in: fin, out: fout }
      : { kind: 'frame', frame: kind, body, budgets, condition: 'c', in: fin, out: fout }
  ) as FlowNode;
  return {
    version: 1,
    id: 'f',
    name: 'f',
    nodes: { a: { kind: 'source', fn: 'f', out: fin }, f: frame, s: { kind: 'sink', fn: 'f', in: fout } },
    edges: [e('a', 'out', 'f', 'in'), e('f', 'out', 's', 'in')],
  };
};

describe('GM-2: E_TYPE_MISMATCH edges', () => {
  it.each<[string, PortSpec, PortSpec]>([
    ['string into number', str, num],
    ['number into integer', num, int],
    ['untyped {} into typed string (ADR 0004)', any, str],
  ])('GM-2: E_TYPE_MISMATCH %s', (_name, from, to) => {
    const r = validateFlow(direct(from, to));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path, x.edge])).toEqual([['E_TYPE_MISMATCH', '/edges/0', 'a.out->s.in']]);
  });

  it('GM-2: E_TYPE_MISMATCH an untyped source tells the author to type the producing port', () => {
    const r = validateFlow(direct(any, str));
    if (r.ok) throw new Error('expected a mismatch');
    expect(r.errors[0]?.message).toMatch(/producing port/i);
  });

  it.each<[string, PortSpec, PortSpec]>([
    ['integer into number', int, num],
    ['same type', str, str],
    ['untyped {} into untyped {} (ADR 0004)', any, any],
    ['string into untyped {} (ADR 0004)', str, any],
  ])('GM-2: E_TYPE_MISMATCH %s passes', (_name, from, to) => {
    expect(validateFlow(direct(from, to)).ok).toBe(true);
  });

  it('GM-2: E_TYPE_MISMATCH a body edge carries the scope-prefixed path and edge id', () => {
    const body = {
      nodes: { x: { kind: 'map', fn: 'f', in: str, out: str }, y: { kind: 'map', fn: 'f', in: num, out: str } } as Record<string, FlowNode>,
      edges: [e('x', 'out', 'y', 'in')],
      entry: { node: 'x', port: 'in' },
      exit: { node: 'y', port: 'out' },
    };
    const flow: Flow = {
      version: 1,
      id: 'f',
      name: 'f',
      nodes: {
        a: { kind: 'source', fn: 'f', out: str },
        f: { kind: 'frame', frame: 'foreach', body, budgets, concurrency: 1, in: str, out: str },
        s: { kind: 'sink', fn: 'f', in: str },
      },
      edges: [e('a', 'out', 'f', 'in'), e('f', 'out', 's', 'in')],
    };
    const r = validateFlow(flow);
    if (r.ok) throw new Error('expected a mismatch');
    expect(r.errors.map((x) => [x.code, x.path, x.edge])).toEqual([['E_TYPE_MISMATCH', '/nodes/f/body/edges/0', 'f.x.out->f.y.in']]);
  });
});

describe('GM-2: E_TYPE_MISMATCH skips invalid endpoints', () => {
  it('GM-2: E_TYPE_MISMATCH an edge into an unknown port reports only E_UNKNOWN_PORT', () => {
    const flow: Flow = {
      version: 1,
      id: 'f',
      name: 'f',
      nodes: {
        a: { kind: 'source', fn: 'f', out: str },
        b: { kind: 'source', fn: 'f', out: num },
        s: { kind: 'sink', fn: 'f', in: num },
      },
      edges: [e('a', 'out', 's', 'nope'), e('b', 'out', 's', 'in')], // b feeds s.in, so s is not unconnected
    };
    expect(errs(flow)).toEqual([['E_UNKNOWN_PORT', '/edges/0/to/port']]);
  });
});

describe('GM-2: E_TYPE_MISMATCH frame boundary', () => {
  it('GM-2: E_TYPE_MISMATCH matching boundary schemas pass', () => {
    expect(validateFlow(framed('foreach', str, str, str, str)).ok).toBe(true);
  });

  it('GM-2: E_TYPE_MISMATCH frame in not assignable to the body entry port', () => {
    expect(errs(framed('foreach', str, str, num, str))).toEqual([['E_TYPE_MISMATCH', '/nodes/f/body/entry']]);
  });

  it('GM-2: E_TYPE_MISMATCH body exit port not assignable to the frame out', () => {
    expect(errs(framed('foreach', str, num, str, str))).toEqual([['E_TYPE_MISMATCH', '/nodes/f/body/exit']]);
  });

  // assignability runs exit port -> frame out, not the other way round
  it('GM-2: E_TYPE_MISMATCH body exit integer into frame out number passes', () => {
    expect(validateFlow(framed('foreach', str, num, str, int)).ok).toBe(true);
  });

  it('GM-2: E_TYPE_MISMATCH body exit number into frame out integer fails', () => {
    expect(errs(framed('foreach', str, int, str, num))).toEqual([['E_TYPE_MISMATCH', '/nodes/f/body/exit']]);
  });
});

describe('GM-5: while/until state loop', () => {
  // frame in integer, out number; body in integer. Body out `number` is not assignable to body in `integer`.
  it.each<['while' | 'until']>([['while'], ['until']])('GM-5: a %s frame whose body output is not assignable to its input yields E_TYPE_MISMATCH', (kind) => {
    const r = validateFlow(framed(kind, int, num, int, num));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([['E_TYPE_MISMATCH', '/nodes/f/body']]);
  });

  it.each<['while' | 'until']>([['while'], ['until']])('GM-5: a %s frame whose body output is assignable to its input passes', (kind) => {
    expect(validateFlow(framed(kind, int, int, num, int)).ok).toBe(true);
  });

  it('GM-5: a foreach frame has no state loop', () => {
    expect(validateFlow(framed('foreach', int, num, int, num)).ok).toBe(true);
  });
});

describe('GM-2: E_TYPE_MISMATCH retry emit-error port', () => {
  const errorSchema: PortSpec = {
    type: 'object',
    properties: { message: { type: 'string' }, item: {} },
    required: ['message', 'item'],
  };
  // a -> r.in; r.out -> s1; r.error -> s2 (typed `errIn`).
  const withError = (errIn: PortSpec): Flow => {
    const body = { nodes: { x: { kind: 'map', fn: 'f', in: str, out: str } as FlowNode }, edges: [], entry: { node: 'x', port: 'in' }, exit: { node: 'x', port: 'out' } };
    return {
      version: 1,
      id: 'f',
      name: 'f',
      nodes: {
        a: { kind: 'source', fn: 'f', out: str },
        r: {
          kind: 'frame',
          frame: 'retry',
          body,
          budgets,
          maxAttempts: 3,
          backoff: { kind: 'fixed', baseMs: 10 },
          onExhausted: 'emit-error',
          in: str,
          out: str,
        },
        s1: { kind: 'sink', fn: 'f', in: str },
        s2: { kind: 'sink', fn: 'f', in: errIn },
      },
      edges: [e('a', 'out', 'r', 'in'), e('r', 'out', 's1', 'in'), e('r', 'error', 's2', 'in')],
    };
  };

  it('GM-2: E_TYPE_MISMATCH retry error port feeding a compatible input passes', () => {
    expect(validateFlow(withError(errorSchema)).ok).toBe(true);
  });

  it('GM-2: E_TYPE_MISMATCH retry error port feeding an incompatible input fails', () => {
    expect(errs(withError(str))).toEqual([['E_TYPE_MISMATCH', '/edges/2']]);
  });
});
