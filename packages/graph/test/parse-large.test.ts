import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { inferSchema } from '../src/schema.js';
import type { JsonValue, ParseResult } from '../src/types.js';
import { type Rec, ref, edge, mapNode, validFlow, SRC, FE, SRC_OUT, get, edit, canon, parsed, errorsOf, brief, DEEP, WIDE, deepArrays, deepObjects, deepAlternating, deepSchema, nestedFrames } from './parse-helpers.js';

// parseFlow on large inputs (split from parse.test.ts so the files run in parallel).

describe('T12: large inputs run in linear time', () => {
  // The repo's ratio guard (see schema.test.ts): ONE call at n against TEN calls at n/10, interleaved, after a warm-up.
  // Linear code stays below ~3x; a quadratic regression shows ~8-20x. A borderline attempt is retried, up to three.
  const MAX_GROWTH = 4;
  const FLOOR_MS = 25;
  const elapsed = (fn: () => unknown): number => {
    const start = Date.now();
    fn();
    return Date.now() - start;
  };
  const expectLinear = <T>(label: string, make: (n: number) => T, runIt: (input: T) => unknown, n = WIDE): void => {
    const big = make(n);
    const small = make(n / 10);
    runIt(small);
    const attempts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const tenSmall = elapsed(() => {
        for (let k = 0; k < 10; k++) runIt(small);
      });
      const oneBig = elapsed(() => runIt(big));
      const growth = oneBig / Math.max(tenSmall, FLOOR_MS);
      if (growth <= MAX_GROWTH) return;
      attempts.push(`${oneBig} ms for n=${n} vs ${tenSmall} ms for 10 x n=${n / 10}`);
      if (growth > 2 * MAX_GROWTH) break;
    }
    expect(attempts, `${label} grows faster than linearly`).toEqual([]);
  };
  const okParse = (input: unknown): void => {
    const r: ParseResult = parseFlow(input);
    if (!r.ok) throw new Error(`unexpected rejection: ${JSON.stringify(r.errors.slice(0, 2))}`);
  };
  const failParse = (input: unknown): void => {
    const r: ParseResult = parseFlow(input);
    if (r.ok) throw new Error('unexpected acceptance');
  };

  it('T12: nested frames, deep schemas and deep samples are linear in depth', () => {
    expectLinear('nested frames', (n) => nestedFrames(n, { kind: 'map', fn: 'f', in: {}, out: {} }), okParse, DEEP);
    for (const kind of ['arrays', 'objects', 'alternating'] as const) {
      expectLinear(`deep ${kind} schema`, (n) => edit(validFlow(), SRC_OUT, deepSchema(kind, n, { type: 'integer' }).schema), okParse, DEEP);
    }
    expectLinear('deep array sample', (n) => edit(validFlow(), SRC_OUT, { inferFrom: [deepArrays(n, 1)] }), okParse, DEEP);
    expectLinear('deep object sample', (n) => edit(validFlow(), SRC_OUT, { inferFrom: [deepObjects(n, 1)] }), okParse, DEEP);
    expectLinear('deep params', (n) => edit(validFlow(), [...SRC, 'params'], deepAlternating(n, 1)), okParse, DEEP);
  }, 120_000);

  it('T12: 100,000 inferFrom samples resolve to the inferred schema, in linear time', () => {
    const records = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => ({ id: i, name: `n${i}`, tags: [`t${i}`] }));
    const mixed = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => (i % 3 === 0 ? i : i % 3 === 1 ? `s${i}` : null));
    expectLinear('inferFrom records', (n) => edit(validFlow(), SRC_OUT, { inferFrom: records(n) }), okParse);
    expectLinear('inferFrom mixed', (n) => edit(validFlow(), SRC_OUT, { inferFrom: mixed(n) }), okParse);
    expect(canon(get(parsed(edit(validFlow(), SRC_OUT, { inferFrom: records(WIDE) })), SRC_OUT))).toStrictEqual(canon(inferSchema(records(WIDE))));
    expect(canon(get(parsed(edit(validFlow(), SRC_OUT, { inferFrom: mixed(WIDE) })), SRC_OUT))).toStrictEqual(canon(inferSchema(mixed(WIDE))));
  }, 120_000);

  it('T12: a bad sample among 100,000 is reported at its index, and many bad samples are all reported in order', () => {
    const samples: unknown[] = Array.from({ length: WIDE }, (_, i) => ({ id: i }));
    samples[WIDE - 1] = { id: 1, bad: undefined };
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: samples })))).toEqual([{ code: 'E_SHAPE', path: `/nodes/src/out/inferFrom/${WIDE - 1}/bad` }]);
    const many: unknown[] = Array.from({ length: WIDE }, (_, i) => (i % 100 === 0 ? { v: () => i } : { v: i }));
    const errors = errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: many }));
    const expected = Array.from({ length: WIDE / 100 }, (_, k) => `/nodes/src/out/inferFrom/${k * 100}/v`).sort();
    expect(errors.map((e) => e.path)).toEqual(expected);
  }, 120_000);

  it('T12: 100,000 nodes, edges and body nodes parse in linear time', () => {
    const nodes = (n: number): Rec => ({ version: 1, id: 'wide', name: 'wide', nodes: Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, mapNode()])), edges: [] });
    const edges = (n: number): Rec => ({ version: 1, id: 'wide', name: 'wide', nodes: {}, edges: Array.from({ length: n }, (_, i) => edge(`n${i}`, 'out', `n${i + 1}`, 'in')) });
    const bodyNodes = (n: number): Rec => edit(validFlow(), [...FE, 'body', 'nodes'], Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, mapNode()])));
    expectLinear('wide nodes', nodes, okParse);
    expectLinear('many edges', edges, okParse);
    expectLinear('wide body', bodyNodes, okParse);
    expect(Object.keys(parsed(nodes(WIDE))['nodes'] as Rec)).toHaveLength(WIDE);
    expect(parsed(edges(WIDE))['edges'] as unknown[]).toHaveLength(WIDE);
  }, 120_000);

  it('T12: 100,000 errors are collected, sorted by path, in linear time', () => {
    const badEdges = (n: number): Rec => ({ version: 1, id: 'wide', name: 'wide', nodes: {}, edges: Array.from({ length: n }, () => ({ from: ref('a', 'out') })) });
    expectLinear('many errors', badEdges, failParse);
    const errors = errorsOf(badEdges(WIDE));
    expect(errors.map((e) => e.path)).toEqual(Array.from({ length: WIDE }, (_, i) => `/edges/${i}/to`).sort());
  }, 120_000);

  it('T12: wide schemas (100,000 properties, required names, anyOf members, enum members) are linear', () => {
    const properties = (n: number): Rec => {
      const props: Rec = {};
      for (let i = 0; i < n; i++) props[`k${i}`] = { type: 'integer' };
      return edit(validFlow(), SRC_OUT, { type: 'object', properties: props, required: Object.keys(props) });
    };
    const anyOf = (n: number): Rec => edit(validFlow(), SRC_OUT, { anyOf: Array.from({ length: n }, () => ({ type: 'string' })) });
    const enumOf = (n: number): Rec => edit(validFlow(), SRC_OUT, { enum: Array.from({ length: n }, (_, i) => `m${i}`) });
    expectLinear('wide properties', properties, okParse);
    expectLinear('wide anyOf', anyOf, okParse);
    expectLinear('wide enum', enumOf, okParse);
    const out = get(parsed(properties(WIDE)), SRC_OUT) as Rec;
    expect(Object.keys(out['properties'] as Rec)).toHaveLength(WIDE);
    expect(out['required'] as unknown[]).toHaveLength(WIDE);
    expect((get(parsed(enumOf(WIDE)), [...SRC_OUT, 'enum']) as unknown[]).at(-1)).toBe(`m${WIDE - 1}`);
  }, 120_000);
});
