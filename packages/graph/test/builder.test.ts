import { describe, expect, it } from 'vitest';
import { flow } from '../src/builder.js';
import type { Body, Flow, Frame, PortSpec, Schema } from '../src/types.js';

const str: Schema = { type: 'string' };
const ref = (node: string, port: string) => ({ node, port });

const body: Body = {
  nodes: {
    work: { kind: 'map', fn: 'work', in: str, out: str },
  },
  edges: [],
  entry: ref('work', 'in'),
  exit: ref('work', 'out'),
};

const foreachFrame: Frame = {
  kind: 'frame',
  frame: 'foreach',
  body,
  budgets: { maxIterations: 10, maxDurationMs: 1000 },
  concurrency: 2,
  in: { type: 'array', items: str },
  out: { type: 'array', items: str },
};

describe('T17: flow() builder', () => {
  it('T17: source->map->sink output deep-equals the hand-written literal', () => {
    const built = flow('f1', 'Flow One')
      .source('s', { fn: 'read', params: { path: 'a.txt' }, out: str })
      .map('m', { fn: 'upper', params: { mode: 'x' }, in: str, out: str, concurrency: 3 })
      .sink('k', { fn: 'write', params: { dest: 'o' }, in: str, concurrency: 4 })
      .edge('s.out', 'm.in')
      .edge('m.out', 'k.in')
      .build();

    const literal: Flow = {
      version: 1,
      id: 'f1',
      name: 'Flow One',
      nodes: {
        s: { kind: 'source', fn: 'read', params: { path: 'a.txt' }, out: str },
        m: { kind: 'map', fn: 'upper', params: { mode: 'x' }, in: str, out: str, concurrency: 3 },
        k: { kind: 'sink', fn: 'write', params: { dest: 'o' }, in: str, concurrency: 4 },
      },
      edges: [
        { from: ref('s', 'out'), to: ref('m', 'in') },
        { from: ref('m', 'out'), to: ref('k', 'in') },
      ],
    };
    expect(built).toEqual(literal);
  });

  it('T17: a foreach frame with a literal body deep-equals the hand-written literal', () => {
    const built = flow('f2', 'Loop')
      .source('s', { fn: 'read', out: { type: 'array', items: str } })
      .frame('loop', foreachFrame)
      .edge('s.out', 'loop.in')
      .build();

    const literal: Flow = {
      version: 1,
      id: 'f2',
      name: 'Loop',
      nodes: {
        s: { kind: 'source', fn: 'read', out: { type: 'array', items: str } },
        loop: foreachFrame,
      },
      edges: [{ from: ref('s', 'out'), to: ref('loop', 'in') }],
    };
    expect(built).toEqual(literal);
  });

  it('T17: build() twice returns independent objects', () => {
    const b = flow('f3', 'Indep').source('s', { fn: 'read', params: { a: [1] }, out: str }).frame('loop', foreachFrame);
    const first = b.build();
    const snapshot = structuredClone(first);
    const second = b.build();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.nodes).not.toBe(first.nodes);
    expect(second.edges).not.toBe(first.edges);

    // mutating one build (shallow and deep) leaves the other alone
    first.name = 'changed';
    delete first.nodes['s'];
    (first.nodes['loop'] as Frame).body.nodes['extra'] = { kind: 'sink', fn: 'x', in: str };
    first.edges.push({ from: ref('a', 'out'), to: ref('b', 'in') });
    expect(second).toEqual(snapshot);

    // later builder calls do not reach into earlier builds
    const third = b.build();
    b.sink('k', { fn: 'write', in: str }).edge('s.out', 'k.in');
    expect(third).toEqual(snapshot);
    expect(b.build().nodes['k']).toBeDefined();
  });

  it('T17: repeated build() keeps edges in insertion order and later edges still land', () => {
    const b = flow('f9', 'Order').edge('a.out', 'b.in').edge('b.out', 'c.in').edge('c.out', 'd.in');
    const expected = [
      { from: ref('a', 'out'), to: ref('b', 'in') },
      { from: ref('b', 'out'), to: ref('c', 'in') },
      { from: ref('c', 'out'), to: ref('d', 'in') },
    ];
    const first = b.build();
    const second = b.build();
    expect(first.edges).toEqual(expected);
    expect(second).toEqual(first);
    const third = b.edge('d.out', 'e.in').build();
    expect(third.edges).toEqual([...expected, { from: ref('d', 'out'), to: ref('e', 'in') }]);
  });

  it('T17: does not leak the caller-supplied spec objects into the build', () => {
    const out: Schema = { type: 'object', properties: { a: str } };
    const built = flow('f4', 'Copy').source('s', { fn: 'read', out }).build();
    (out as { properties: Record<string, Schema> }).properties['b'] = str;
    expect(built.nodes['s']).toEqual({ kind: 'source', fn: 'read', out: { type: 'object', properties: { a: str } } });
  });

  it('T17: never validates, so an invalid flow builds fine', () => {
    const built = flow('bad.flow', '')
      .source('dup', { fn: 'a', out: str })
      .sink('has.dot', { fn: 'b', in: str })
      .edge('dup.out', 'missing.in')
      .edge('nodot', 'also-nodot')
      .build();
    expect(Object.keys(built.nodes)).toEqual(['dup', 'has.dot']);
    expect(built.id).toBe('bad.flow');
    expect(built.edges).toHaveLength(2);
    expect(built.edges[0]).toEqual({ from: ref('dup', 'out'), to: ref('missing', 'in') });
  });

  it('T17: edge() splits "node.port" at the last dot, so scoped ids stay whole', () => {
    const built = flow('f5', 'Edges')
      .edge('a.out', 'b.in')
      .edge('loop.a.out', 'loop.b.in')
      .edge('a.b.c.out', 'x.y.in')
      .build();
    expect(built.edges).toEqual([
      { from: ref('a', 'out'), to: ref('b', 'in') },
      { from: ref('loop.a', 'out'), to: ref('loop.b', 'in') },
      { from: ref('a.b.c', 'out'), to: ref('x.y', 'in') },
    ]);
  });

  it('T17: edge() with no dot is not rejected and yields an empty port', () => {
    const built = flow('f6', 'NoDot')
      .edge('nodot' as `${string}.${string}`, 'other' as `${string}.${string}`)
      .build();
    expect(built.edges).toEqual([{ from: ref('nodot', ''), to: ref('other', '') }]);
  });

  it('T17: PortSpec, Schema and { inferFrom } are passed through unchanged', () => {
    const inferred: PortSpec = { inferFrom: [{ a: 1 }, { a: 2 }] };
    const any: Schema = {};
    const union: Schema = { anyOf: [{ type: 'string' }, { enum: [1, 'two', null] }] };
    const built = flow('f7', 'Ports')
      .source('s', { fn: 'read', out: inferred })
      .map('m', { fn: 'id', in: any, out: union })
      .sink('k', { fn: 'write', in: union })
      .build();
    expect(built.nodes['s']).toEqual({ kind: 'source', fn: 'read', out: { inferFrom: [{ a: 1 }, { a: 2 }] } });
    expect(built.nodes['m']).toEqual({ kind: 'map', fn: 'id', in: {}, out: union });
    expect(built.nodes['k']).toEqual({ kind: 'sink', fn: 'write', in: union });
  });

  it('T17: a later node with a duplicate id overwrites the earlier one', () => {
    const built = flow('f8', 'Dup')
      .source('n', { fn: 'first', out: str })
      .sink('n', { fn: 'second', in: str })
      .build();
    expect(Object.keys(built.nodes)).toEqual(['n']);
    expect(built.nodes['n']).toEqual({ kind: 'sink', fn: 'second', in: str });
  });
});
