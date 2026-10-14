import { describe, expect, it } from 'vitest';
import { flow } from '../src/builder.js';
import { parseFlow } from '../src/parse.js';
import { isAssignable } from '../src/schema.js';
import { validateFlow } from '../src/validate.js';
import type { Flow, FlowNode, PortSpec, Schema } from '../src/types.js';
import foreach100k from './fixtures/foreach-100k.flow.json' with { type: 'json' };
import nestedFrames from './fixtures/nested-frames.flow.json' with { type: 'json' };
import retryFlaky from './fixtures/retry-flaky.flow.json' with { type: 'json' };
import simplePipeline from './fixtures/simple-pipeline.flow.json' with { type: 'json' };
import whileCounter from './fixtures/while-counter.flow.json' with { type: 'json' };

const fixtures: [string, unknown][] = [
  ['simple-pipeline', simplePipeline],
  ['foreach-100k', foreach100k],
  ['while-counter', whileCounter],
  ['retry-flaky', retryFlaky],
  ['nested-frames', nestedFrames],
];

const parsed = (name: string, raw: unknown): Flow => {
  const r = parseFlow(raw);
  if (!r.ok) throw new Error(`${name} does not parse: ${JSON.stringify(r.errors)}`);
  return r.flow;
};

describe('GM-1: golden fixtures', () => {
  it.each(fixtures)('GM-1: %s validates ok', (name, raw) => {
    const r = validateFlow(parsed(name, raw));
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('GM-1: the fixtures cover every frame kind, the emit-error port, and a sized foreach', () => {
    const f = foreach100k as { nodes: { generate: { params: { count: number } }; each: { concurrency: number; budgets: object } } };
    expect(f.nodes.generate.params.count).toBe(100_000); // sized by params, the file itself stays small
    expect(f.nodes.each.concurrency).toBeGreaterThan(1);
    expect(f.nodes.each.budgets).toMatchObject({ maxIterations: 100_000 });
    const frames = fixtures.flatMap(([name, raw]) => collect(parsed(name, raw).nodes)).flatMap((n) => (n.kind === 'frame' ? [n.frame] : []));
    expect(new Set(frames)).toEqual(new Set(['foreach', 'while', 'retry']));
    const retry = (retryFlaky as { nodes: { flaky: { onExhausted: string; backoff: object } } }).nodes.flaky;
    expect(retry.onExhausted).toBe('emit-error');
    expect(retry.backoff).toMatchObject({ kind: 'exponential' });
  });

  // The builder is the typed way to author flows; two fixtures must be exactly what it produces.
  it('GM-1: simple-pipeline equals its flow()-built counterpart', () => {
    const user: Schema = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] };
    const labelled: Schema = { type: 'object', properties: { id: { type: 'integer' }, label: { type: 'string' } }, required: ['id', 'label'] };
    const built = flow('simple-pipeline', 'Simple pipeline: read, normalise, write')
      .source('read', { fn: 'csv.read', params: { path: 'input.csv', delimiter: ',' }, out: user })
      .map('normalize', { fn: 'text.normalize', params: { field: 'name', case: 'lower' }, in: user, out: labelled })
      .sink('write', { fn: 'jsonl.write', params: { path: 'output.jsonl' }, in: labelled })
      .edge('read.out', 'normalize.in')
      .edge('normalize.out', 'write.in')
      .build();
    expect(built).toEqual(simplePipeline);
    expect(parsed('simple-pipeline', simplePipeline)).toEqual(built);
    expect(validateFlow(built).ok).toBe(true);
  });

  it('GM-1: while-counter equals its flow()-built counterpart', () => {
    const state: Schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] };
    const increment: FlowNode = { kind: 'map', fn: 'counter.increment', params: { by: 1 }, in: state, out: state };
    const built = flow('while-counter', 'Count up until the limit is reached')
      .source('init', { fn: 'state.init', params: { count: 0 }, out: state })
      .frame('loop', {
        kind: 'frame',
        frame: 'while',
        condition: 'state.count < 10',
        budgets: { maxIterations: 100, maxDurationMs: 60_000 },
        in: state,
        out: state,
        body: { nodes: { increment }, edges: [], entry: { node: 'increment', port: 'in' }, exit: { node: 'increment', port: 'out' } },
      })
      .sink('report', { fn: 'log.report', in: state })
      .edge('init.out', 'loop.in')
      .edge('loop.out', 'report.in')
      .build();
    expect(built).toEqual(whileCounter);
    expect(parsed('while-counter', whileCounter)).toEqual(built);
    expect(validateFlow(built).ok).toBe(true);
  });
});

// Every node in a scope tree, bodies included.
function collect(nodes: Record<string, FlowNode>): FlowNode[] {
  return Object.values(nodes).flatMap((n) => (n.kind === 'frame' ? [n, ...collect(n.body.nodes)] : [n]));
}

describe('GM-7: isAssignable on the fixture schemas', () => {
  // A port schema plus every schema nested inside it (properties, items, anyOf members).
  const withNested = (s: Schema): Schema[] => [
    s,
    ...('properties' in s ? Object.values(s.properties).flatMap(withNested) : []),
    ...('items' in s ? withNested(s.items) : []),
    ...('anyOf' in s ? s.anyOf.flatMap(withNested) : []),
  ];
  const concrete = (p: PortSpec | undefined): Schema[] => (p === undefined || 'inferFrom' in p ? [] : withNested(p));
  const schemas: Schema[] = [
    ...new Map(
      fixtures
        .flatMap(([name, raw]) => collect(parsed(name, raw).nodes))
        .flatMap((n) => [...concrete('in' in n ? n.in : undefined), ...concrete('out' in n ? n.out : undefined)])
        .map((s) => [JSON.stringify(s), s] as const),
    ).values(),
  ];

  it('GM-7: the fixtures expose a varied schema set', () => {
    expect(schemas.length).toBeGreaterThanOrEqual(6);
    const kinds = new Set(schemas.map((s) => ('type' in s ? s.type : 'other')));
    expect(kinds).toEqual(new Set(['integer', 'number', 'string', 'object', 'other']));
  });

  it('GM-7: isAssignable is reflexive on schemas extracted from the fixtures', () => {
    expect(schemas.filter((s) => !isAssignable(s, s))).toEqual([]);
  });

  it('GM-7: isAssignable is transitive on schemas extracted from the fixtures', () => {
    const misses: string[] = [];
    let chains = 0;
    for (const a of schemas)
      for (const b of schemas)
        for (const c of schemas) {
          if (!isAssignable(a, b) || !isAssignable(b, c)) continue;
          chains++;
          if (!isAssignable(a, c)) misses.push(JSON.stringify([a, b, c]));
        }
    expect(misses).toEqual([]);
    expect(chains).toBeGreaterThan(schemas.length); // more than the reflexive triples: a real chain was exercised
  });

  it('GM-7: integer is assignable to number, not the reverse (both occur in the fixtures)', () => {
    const integer: Schema = { type: 'integer' };
    const number: Schema = { type: 'number' };
    expect(schemas).toContainEqual(integer);
    expect(schemas).toContainEqual(number);
    expect(isAssignable(integer, number)).toBe(true);
    expect(isAssignable(number, integer)).toBe(false);
  });
});
