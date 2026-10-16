import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { inferSchema } from '../src/schema.js';
import type { JsonValue, ParseResult } from '../src/types.js';
import { type Rec, GONE, ref, edge, mapNode, frameCommon, validFlow, SRC, MAP, SNK, FE, WH, UN, RT, INNER, SRC_OUT, PORTS, get, edit, deepFreeze, canon, pairs, parsed, errorsOf, brief, pathsOf, expectWellFormed, hasKeyDeep, objectsOf, mulberry32, shuffled, VALID_SCHEMAS, DEEP, deepArrays, deepObjects, deepAlternating, peelJson, deepSchema, peelSchema, nestedFrames, peelFrames } from './parse-helpers.js';


// parseFlow: the structural parse (shape and JSON types, not semantics) that also resolves every `{ inferFrom }` port.
// The per-case code/path tables live in codes/e-shape.test.ts; this file pins the cross-cutting behaviour.
//
// Decisions pinned here that the spec and the task brief leave open (the reviewer checks these against the spec):
//  - Every error parseFlow returns has code E_SHAPE, a non-empty message, a string path, and `node` only when the error
//    lies at or under a node entry. The errors are unique per (code, path) and sorted by path in PLAIN string order
//    (UTF-16 code units: `/edges/10` before `/edges/2`, `B` before `a`, `z` before `é`), never locale or natural order.
//  - `parseFlow(flowThatAlreadyParsed)` is the identity (idempotent), and a valid flow comes back EQUAL to the input
//    (same own keys, no `undefined`-valued keys added, nothing dropped), as a fresh object graph sharing no object with
//    the input and not frozen even when the input is.
//  - `{ inferFrom }` is resolved only in PortSpec position. As data (a property NAMED inferFrom, an enum member, `params`,
//    a sample) it is left alone.
//  - Non-plain objects (class instances, Map, Date, ...) are rejected; null-prototype objects count as plain.
//  - A cyclic structure is E_SHAPE at the path of the reference that closes the cycle (the first revisit of an ancestor);
//    the same object reachable twice WITHOUT being its own ancestor (a DAG) is valid JSON and valid shape, and an error
//    inside it is reported at every path it is reachable from.
//  - A getter or Proxy trap that throws, and a revoked Proxy, are E_SHAPE at the path being read, never an exception.
//    A Proxy that behaves transparently is parsed as its target. A root whose prototype cannot be read is E_SHAPE at ''.
//  - Unknown extra keys (on the flow root, every node kind, bodies, budgets, backoff, edges and PortRefs) are E_SHAPE at
//    `<object path>/<key>`, collected with every other error; they never throw and never pollute, `__proto__` included. The
//    per-object table lives in codes/e-shape.test.ts.
//  - NaN, Infinity and -Infinity anywhere, and a key that is present but holds `undefined`, are E_SHAPE at that path (same
//    table file); an absent optional key is fine.


// ---------------------------------------------------------------------------------------------------------------------
// A valid object parses ok, equal to the input, without mutating it
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE a valid object parses ok', () => {
  it('GM-2: E_SHAPE a valid object returns ok:true with an equal flow and does not mutate the (deep-frozen) input', () => {
    const input = deepFreeze(validFlow());
    const result: ParseResult = parseFlow(input);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['flow', 'ok']);
    if (result.ok) expect(canon(result.flow)).toStrictEqual(canon(validFlow()));
    expect(canon(input)).toStrictEqual(canon(validFlow()));
  });

  it('GM-2: E_SHAPE a rejected object returns ok:false with errors only, and does not mutate the (deep-frozen) input', () => {
    const input = deepFreeze(edit(validFlow(), ['version'], 2));
    const result: ParseResult = parseFlow(input);
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['errors', 'ok']);
    expect(canon(input)).toStrictEqual(canon(edit(validFlow(), ['version'], 2)));
  });

  const valid: Array<[string, () => unknown]> = [
    ['the base flow', validFlow],
    ['the empty flow', () => ({ version: 1, id: 'e', name: 'e', nodes: {}, edges: [] })],
    ['the base flow after a JSON round trip', () => JSON.parse(JSON.stringify(validFlow()))],
    [
      'a null-prototype root and nodes record',
      () => Object.assign(Object.create(null), validFlow(), { nodes: Object.assign(Object.create(null), validFlow()['nodes']) }),
    ],
    ['dotted and unusual node ids (parseFlow does not police ids)', () => ({ ...validFlow(), nodes: { 'a.b': mapNode(), '': mapNode(), 'x y': mapNode(), é: mapNode() } })],
    ['dangling and duplicate edges (parseFlow does not police wiring)', () => ({ ...validFlow(), edges: [edge('nope', 'x', 'gone', 'y'), edge('nope', 'x', 'gone', 'y')] })],
    ['a source without params', () => edit(validFlow(), [...SRC, 'params'], GONE)],
    ['params of every JSON kind', () => edit(validFlow(), [...SRC, 'params'], { a: [1, 'x', null, true, { b: [] }], c: {}, d: '' })],
    ['params that is null', () => edit(validFlow(), [...SRC, 'params'], null)],
    ['params that is a string', () => edit(validFlow(), [...SRC, 'params'], 'x')],
    ['a map and a sink without concurrency', () => edit(edit(validFlow(), [...MAP, 'concurrency'], GONE), [...SNK, 'concurrency'], GONE)],
    ['budgets without the optional cost and token limits', () => edit(validFlow(), [...FE, 'budgets'], { maxIterations: 5, maxDurationMs: 5 })],
    ['a retry frame with fixed backoff and fail-run', () => edit(edit(validFlow(), [...RT, 'backoff'], { kind: 'fixed', baseMs: 0 }), [...RT, 'onExhausted'], 'fail-run')],
    ['frames without their semantic fields', () => {
      const f = validFlow();
      for (const at of [[...FE, 'concurrency'], [...WH, 'condition'], [...UN, 'condition'], [...RT, 'maxAttempts'], [...RT, 'backoff', 'baseMs']]) edit(f, at, GONE);
      return edit(edit(f, [...FE, 'budgets'], {}), [...RT, 'budgets'], {});
    }],
    ['an empty frame body', () => edit(validFlow(), [...FE, 'body'], { nodes: {}, edges: [], entry: ref('x', 'p'), exit: ref('y', 'q') })],
    ['the same schema object used at several ports', () => {
      const shared = { type: 'string' };
      return edit(edit(validFlow(), [...MAP, 'in'], shared), [...SNK, 'in'], shared);
    }],
    ...VALID_SCHEMAS.map((schema, i): [string, () => unknown] => [`schema ${i}: ${JSON.stringify(schema)}`, () => edit(validFlow(), SRC_OUT, schema)]),
    ...VALID_SCHEMAS.map((schema, i): [string, () => unknown] => [`schema ${i} as a frame in and a nested map out`, () => edit(edit(validFlow(), [...FE, 'in'], schema), [...INNER, 'body', 'nodes', 'b', 'out'], schema)]),
    ['properties named like schema keywords and enum members shaped like specs', () => edit(validFlow(), SRC_OUT, {
      type: 'object',
      properties: { type: { type: 'string' }, pattern: {}, $ref: {}, inferFrom: {}, enum: {}, required: {}, items: {}, anyOf: {} },
      required: ['type', 'pattern'],
    })],
    ['an enum whose members look like specs', () => edit(validFlow(), SRC_OUT, { enum: [{ type: 'string', pattern: 'x', $ref: '#' }, { inferFrom: [1] }, { anyOf: [] }] })],
  ];

  it.each(valid)('GM-2: E_SHAPE %s parses ok and comes back equal', (_name, make) => {
    const flow = parsed(make());
    expect(canon(flow)).toStrictEqual(canon(make()));
  });

  it.each(valid)('T12: parsing the parsed flow of %s changes nothing (idempotent)', (_name, make) => {
    const once = parsed(make());
    const twice = parsed(once);
    expect(canon(twice)).toStrictEqual(canon(once));
  });

  it('T12: a null-prototype root, nodes record and sample objects are plain objects', () => {
    const sample = Object.assign(Object.create(null), { a: 1 });
    const flow = parsed(edit(Object.assign(Object.create(null), validFlow()), SRC_OUT, { inferFrom: [sample] }));
    expect(canon(get(flow, SRC_OUT))).toStrictEqual(canon(inferSchema([{ a: 1 }])));
  });

  it('T12: every error list of a rejected input is well formed (E_SHAPE, messages, unique, sorted)', () => {
    const inputs: unknown[] = [
      null,
      5,
      edit(validFlow(), ['version'], 2),
      { version: 2, id: 5, name: 7, nodes: 'x', edges: 1 },
      edit(edit(validFlow(), SRC_OUT, { type: 'string', enum: ['a'], anyOf: [{}] }), [...MAP, 'in'], { pattern: 'x', $ref: 'y', format: 'z' }),
      edit(validFlow(), SRC_OUT, { inferFrom: [undefined, () => 1, Symbol('s'), 1n, Number.NaN, new Date(0)] }),
    ];
    for (const input of inputs) expectWellFormed(errorsOf(input));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// inferFrom resolution
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE inferFrom resolution', () => {
  const sets: Array<[string, () => JsonValue[]]> = [
    ['no samples', () => []],
    ['one integer', () => [1]],
    ['an integer and a fraction', () => [1, 2.5]],
    ['strings', () => ['a', 'b']],
    ['records with differing keys', () => [{ a: 1 }, { a: 2, b: 'x' }]],
    ['arrays of numbers', () => [[1], [2, 3]]],
    ['every kind', () => [1, 'a', null, true, [1], { a: 1 }]],
    ['deeply mixed records', () => [{ a: { b: [{ c: 1 }, { c: 'x' }] } }, { a: { b: [] } }]],
    ['a record with a key named inferFrom', () => [{ inferFrom: [1] }, { inferFrom: ['x'] }]],
    ['records with __proto__ and constructor keys', () => [JSON.parse('{"__proto__":{"x":1},"constructor":"c"}') as JsonValue, { constructor: 'd' }]],
    ['empty keys and empty arrays', () => [{ '': [] }, { '': [1] }]],
    ['integral numbers beyond 2^53', () => [2 ** 53, 1e300]],
    ['unicode strings', () => ['é', '😀', '']],
    ['the same sample object repeated', () => {
      const shared = { a: [1] };
      return [shared, shared, { x: shared, y: shared }];
    }],
    ['200 mixed samples', () => Array.from({ length: 200 }, (_, i): JsonValue => (i % 4 === 0 ? i : i % 4 === 1 ? `s${i}` : i % 4 === 2 ? { id: i } : [i]))],
  ];

  it.each(sets)('GM-2: E_SHAPE inferFrom of %s resolves to inferSchema(samples)', (_name, make) => {
    const flow = parsed(edit(validFlow(), SRC_OUT, { inferFrom: make() }));
    expect(pairs(get(flow, SRC_OUT))).toStrictEqual(pairs(inferSchema(make())));
    expect(hasKeyDeep(get(flow, SRC_OUT), 'inferFrom') && !JSON.stringify(make()).includes('inferFrom')).toBe(false);
  });

  it('GM-2: E_SHAPE an empty inferFrom resolves to the any-schema {}', () => {
    expect(canon(get(parsed(edit(validFlow(), SRC_OUT, { inferFrom: [] })), SRC_OUT))).toStrictEqual({});
  });

  it('GM-2: E_SHAPE inferFrom resolves at every PortSpec position, including nested bodies and frame in/out', () => {
    for (const at of PORTS) {
      const flow = parsed(edit(validFlow(), at, { inferFrom: [{ a: 1 }, { a: 2.5, b: 'x' }] }));
      expect(canon(get(flow, at)), at.join('/')).toStrictEqual(canon(inferSchema([{ a: 1 }, { a: 2.5, b: 'x' }])));
    }
  });

  it('GM-2: E_SHAPE inferFrom at every position at once: each is resolved to its own schema and none is left', () => {
    const input = validFlow();
    PORTS.forEach((at, i) => edit(input, at, { inferFrom: [i, `s${i}`] }));
    expect(hasKeyDeep(input, 'inferFrom')).toBe(true);
    const flow = parsed(input);
    expect(hasKeyDeep(flow, 'inferFrom'), 'no inferFrom left anywhere').toBe(false);
    PORTS.forEach((at, i) => expect(canon(get(flow, at)), at.join('/')).toStrictEqual(canon(inferSchema([i, `s${i}`]))));
    expect(JSON.stringify(flow)).not.toContain('inferFrom');
  });

  it('GM-2: E_SHAPE a Flow still holding inferFrom (as the builder produces) is resolved by passing it through parseFlow, and the result is stable', () => {
    const flow = parsed(edit(validFlow(), [...MAP, 'in'], { inferFrom: [1, 2] }));
    expect(canon(get(flow, [...MAP, 'in']))).toStrictEqual({ type: 'integer' });
    expect(canon(parsed(flow))).toStrictEqual(canon(flow));
  });

  it('GM-2: E_SHAPE inferFrom is only resolved in PortSpec position: as data it is left alone', () => {
    const asProperty = { type: 'object', properties: { inferFrom: { type: 'array', items: { type: 'integer' } } }, required: ['inferFrom'] };
    const flow = parsed(
      edit(
        edit(edit(validFlow(), SRC_OUT, asProperty), [...MAP, 'in'], { enum: [{ inferFrom: [1] }, [{ inferFrom: [2] }]] }),
        [...SRC, 'params'],
        { inferFrom: [1, 2], nested: { inferFrom: [] } },
      ),
    );
    expect(canon(get(flow, SRC_OUT))).toStrictEqual(canon(asProperty));
    expect(canon(get(flow, [...MAP, 'in']))).toStrictEqual({ enum: [{ inferFrom: [1] }, [{ inferFrom: [2] }]] });
    expect(canon(get(flow, [...SRC, 'params']))).toStrictEqual({ inferFrom: [1, 2], nested: { inferFrom: [] } });
  });

  it('GM-2: E_SHAPE samples that contain an inferFrom record are inferred, not resolved', () => {
    const samples: JsonValue[] = [{ inferFrom: [1, 2] }, { inferFrom: [3] }];
    const flow = parsed(edit(validFlow(), SRC_OUT, { inferFrom: samples }));
    expect(canon(get(flow, SRC_OUT))).toStrictEqual(canon(inferSchema(samples)));
    expect(canon(get(flow, SRC_OUT))).toStrictEqual({ type: 'object', properties: { inferFrom: { type: 'array', items: { type: 'integer' } } }, required: ['inferFrom'] });
  });

  it('GM-2: E_SHAPE resolution does not mutate the samples (deep-frozen) and the resolved schema shares nothing with them', () => {
    const samples: JsonValue[] = [{ a: [1, { b: null }] }, { a: [] }];
    const input = deepFreeze(edit(validFlow(), SRC_OUT, { inferFrom: samples }));
    const flow = parsed(input);
    expect(canon(samples)).toStrictEqual(canon([{ a: [1, { b: null }] }, { a: [] }]));
    const sampleObjects = objectsOf(samples);
    expect([...objectsOf(get(flow, SRC_OUT))].filter((o) => sampleObjects.has(o))).toEqual([]);
  });

  it('GM-2: E_SHAPE inferFrom samples are checked as JSON before inference: every offending sample is reported, none is inferred', () => {
    const cyclic: Rec = {};
    cyclic['self'] = cyclic;
    const errors = errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: [1, undefined, { a: 1 }, cyclic, 'x', { a: () => 1 }, [1, Symbol('s')]] }));
    expect(brief(errors)).toEqual([
      { code: 'E_SHAPE', path: '/nodes/src/out/inferFrom/1' },
      { code: 'E_SHAPE', path: '/nodes/src/out/inferFrom/3/self' },
      { code: 'E_SHAPE', path: '/nodes/src/out/inferFrom/5/a' },
      { code: 'E_SHAPE', path: '/nodes/src/out/inferFrom/6/1' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Collect all errors, deterministic order, de-duplication
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE errors are all collected, de-duplicated and sorted by path', () => {
  const manyErrors = (): Rec => {
    const f = validFlow();
    edit(f, ['version'], 2);
    edit(f, ['id'], 5);
    edit(f, ['name'], GONE);
    edit(f, ['edges', '1', 'to', 'port'], GONE);
    edit(f, [...MAP, 'out'], { pattern: 'x' });
    edit(f, [...FE, 'body', 'entry', 'node'], 5);
    edit(f, SRC_OUT, { inferFrom: [1, 'a', null, undefined] });
    edit(f, [...SNK, 'kind'], 'bad');
    return f;
  };

  it('GM-2: E_SHAPE reports every error, not the first, sorted by path, with the right node', () => {
    const errors = errorsOf(manyErrors());
    expect(errors.map((e) => [e.code, e.path, e.node])).toEqual([
      ['E_SHAPE', '/edges/1/to/port', undefined],
      ['E_SHAPE', '/id', undefined],
      ['E_SHAPE', '/name', undefined],
      ['E_SHAPE', '/nodes/fe/body/entry/node', 'fe'],
      ['E_SHAPE', '/nodes/m/out/pattern', 'm'],
      ['E_SHAPE', '/nodes/snk/kind', 'snk'],
      ['E_SHAPE', '/nodes/src/out/inferFrom/3', 'src'],
      ['E_SHAPE', '/version', undefined],
    ]);
    expectWellFormed(errors);
  });

  it('GM-2: E_SHAPE a flow that is wrong everywhere at the root reports all five fields in order', () => {
    expect(pathsOf({ version: 2, id: 5, name: 7, nodes: 'x', edges: 1 })).toEqual(['/edges', '/id', '/name', '/nodes', '/version']);
    expect(pathsOf({})).toEqual(['/edges', '/id', '/name', '/nodes', '/version']);
  });

  it('GM-2: E_SHAPE several schema errors in one schema are all reported', () => {
    const schema = { type: 'object', properties: { a: { pattern: 'x' }, b: { $ref: 'y' }, c: { type: 'date' } }, required: [1], additionalProperties: 'no' };
    expect(pathsOf(edit(validFlow(), SRC_OUT, schema))).toEqual([
      '/nodes/src/out/additionalProperties',
      '/nodes/src/out/properties/a/pattern',
      '/nodes/src/out/properties/b/$ref',
      '/nodes/src/out/properties/c/type',
      '/nodes/src/out/required/0',
    ]);
  });

  it('GM-2: E_SHAPE errors in separate nodes and bodies are all reported', () => {
    const f = validFlow();
    edit(f, [...FE, 'body', 'nodes', 'a', 'fn'], 1);
    edit(f, [...UN, 'body', 'nodes', 'b', 'fn'], 2);
    edit(f, [...INNER, 'body', 'nodes', 'a', 'kind'], 'x');
    edit(f, [...RT, 'backoff', 'kind'], 'x');
    expect(pathsOf(f)).toEqual([
      '/nodes/fe/body/nodes/a/fn',
      '/nodes/rt/backoff/kind',
      '/nodes/un/body/nodes/b/fn',
      '/nodes/wh/body/nodes/inner/body/nodes/a/kind',
    ]);
  });

  it('GM-2: E_SHAPE a schema mixing three union members is one error, not three', () => {
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, { type: 'string', enum: ['a'], anyOf: [{}] })))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out' }]);
  });

  it('GM-2: E_SHAPE one shared bad schema is reported at every path it is reachable from', () => {
    const bad = { pattern: 'x' };
    expect(pathsOf(edit(edit(validFlow(), SRC_OUT, bad), [...MAP, 'in'], bad))).toEqual(['/nodes/m/in/pattern', '/nodes/src/out/pattern']);
  });

  it('GM-2: E_SHAPE sorts by path in plain string order, not natural, locale or insertion order', () => {
    const kinds = (ids: string[]): Rec => ({ version: 1, id: 'f', name: 'f', nodes: Object.fromEntries(ids.map((id) => [id, { kind: 'x' }])), edges: [] });
    expect(pathsOf(kinds(['a', 'B']))).toEqual(['/nodes/B/kind', '/nodes/a/kind']);
    expect(pathsOf(kinds(['z', 'é']))).toEqual(['/nodes/z/kind', '/nodes/é/kind']);
    expect(pathsOf(kinds(['a0', 'a', 'a.b', 'a-b']))).toEqual(['/nodes/a-b/kind', '/nodes/a.b/kind', '/nodes/a/kind', '/nodes/a0/kind']);
    expect(pathsOf(kinds(['n2', 'n10', 'n1']))).toEqual(['/nodes/n1/kind', '/nodes/n10/kind', '/nodes/n2/kind']);

    const edges = Array.from({ length: 12 }, () => ({ from: ref('a', 'out') }));
    const expected = Array.from({ length: 12 }, (_, i) => `/edges/${i}/to`).sort();
    expect(expected.slice(0, 4)).toEqual(['/edges/0/to', '/edges/1/to', '/edges/10/to', '/edges/11/to']);
    expect(pathsOf({ version: 1, id: 'f', name: 'f', nodes: {}, edges })).toEqual(expected);
  });

  it('GM-2: E_SHAPE the error order does not depend on the insertion order of the input keys', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `n${i}`);
    const expected = ids.map((id) => `/nodes/${id}/kind`).sort();
    for (const seed of [1, 2, 3, 4, 5]) {
      const order = shuffled(mulberry32(seed), ids);
      const flow = { version: 1, id: 'f', name: 'f', nodes: Object.fromEntries(order.map((id) => [id, { kind: 'x' }])), edges: [] };
      expect(pathsOf(flow)).toEqual(expected);
    }
  });

  it('GM-2: E_SHAPE the whole error list is identical for the same input twice, and for reversed key order at every level', () => {
    const reverseKeys = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (typeof v === 'object' && v !== null && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
      return v;
    };
    const a = errorsOf(manyErrors());
    expect(errorsOf(manyErrors())).toEqual(a);
    expect(errorsOf(reverseKeys(manyErrors()))).toEqual(a);
    const b = errorsOf(edit(validFlow(), SRC_OUT, { type: 'object', properties: { y: { pattern: 'a' }, x: { $ref: 'b' } }, required: ['q', 3, 4] }));
    expect(errorsOf(reverseKeys(edit(validFlow(), SRC_OUT, { type: 'object', properties: { y: { pattern: 'a' }, x: { $ref: 'b' } }, required: ['q', 3, 4] })))).toEqual(b);
  });

  it('GM-2: E_SHAPE each call returns a fresh errors array', () => {
    const input = deepFreeze(edit(validFlow(), ['version'], 2));
    const first: ParseResult = parseFlow(input);
    const second: ParseResult = parseFlow(input);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.errors).not.toBe(second.errors);
    first.errors.push({ code: 'E_SHAPE', message: 'x', path: '/zzz' });
    expect(second.errors.map((e) => e.path)).toEqual(['/version']);
  });
});

describe('T12: unknown keys and bad numbers are collected with every other error', () => {
  const own = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };

  it('T12: unknown keys on many objects are all reported, sorted, with the right node, beside ordinary errors', () => {
    const f = edit(validFlow(), ['version'], 2);
    own(f, 'zzz', 1);
    own(f, 'aaa', 1);
    own(get(f, [...FE, 'budgets']) as object, 'cost', 1);
    own(get(f, [...RT, 'backoff']) as object, 'jitter', 1);
    own(get(f, ['edges', '0', 'from']) as object, 'extra', 1);
    own(get(f, [...FE, 'body', 'entry']) as object, 'extra', 1);
    own(get(f, MAP) as object, 'concurency', 1);
    own(get(f, FE) as object, 'maxAttempts', 1);
    const errors = errorsOf(f);
    expect(errors.map((e) => [e.path, e.node])).toEqual([
      ['/aaa', undefined],
      ['/edges/0/from/extra', undefined],
      ['/nodes/fe/body/entry/extra', 'fe'],
      ['/nodes/fe/budgets/cost', 'fe'],
      ['/nodes/fe/maxAttempts', 'fe'],
      ['/nodes/m/concurency', 'm'],
      ['/nodes/rt/backoff/jitter', 'rt'],
      ['/version', undefined],
      ['/zzz', undefined],
    ]);
    expectWellFormed(errors);
  });

  it('T12: an own __proto__ or constructor key is an unknown key, never a prototype write', () => {
    const f = JSON.parse(JSON.stringify(validFlow())) as Rec;
    own(f, '__proto__', { polluted: true });
    own(get(f, MAP) as object, 'constructor', { prototype: { polluted: true } });
    own(get(f, [...FE, 'budgets']) as object, '__proto__', { polluted: true });
    expect(pathsOf(f)).toEqual(['/__proto__', '/nodes/fe/budgets/__proto__', '/nodes/m/constructor']);
    expectNoPollution();
  });

  it('T12: non-finite numbers and present-but-undefined keys are collected beside unknown keys', () => {
    const f = validFlow();
    edit(f, [...FE, 'budgets', 'maxIterations'], Number.NaN);
    edit(f, [...FE, 'concurrency'], Infinity);
    edit(f, [...MAP, 'concurrency'], -Infinity);
    edit(f, [...SRC, 'params'], undefined);
    edit(f, [...UN, 'condition'], undefined);
    own(get(f, SNK) as object, 'extra', 1);
    expect(pathsOf(f)).toEqual([
      '/nodes/fe/budgets/maxIterations',
      '/nodes/fe/concurrency',
      '/nodes/m/concurrency',
      '/nodes/snk/extra',
      '/nodes/src/params',
      '/nodes/un/condition',
    ]);
  });

  it('T12: out-of-range finite numbers and absent optional keys still parse ok (that is validateFlow)', () => {
    const f = validFlow();
    edit(f, [...FE, 'budgets', 'maxIterations'], 0);
    edit(f, [...FE, 'concurrency'], -1);
    edit(f, [...MAP, 'concurrency'], 1.5);
    edit(f, [...SRC, 'params'], GONE);
    edit(f, [...UN, 'condition'], GONE);
    expect(parsed(f)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Immutability and independence of the result
// ---------------------------------------------------------------------------------------------------------------------

const richFlow = (): Rec => {
  const f = validFlow();
  edit(f, [...MAP, 'in'], {
    type: 'object',
    properties: { a: { type: 'array', items: { enum: [1, { k: [2] }] } }, b: { anyOf: [{ type: 'null' }, { type: 'string' }] } },
    required: ['a'],
    additionalProperties: false,
  });
  edit(f, SRC_OUT, { inferFrom: [{ a: [1], b: null }, { a: [2.5] }] });
  edit(f, [...SRC, 'params'], { list: [1, [2, { x: null }]], o: { p: {} } });
  return f;
};

describe('T12: the result is a fresh flow that shares nothing with the input', () => {
  it('T12: no object of the result is an object of the input, and the result is not frozen even when the input is', () => {
    const input = deepFreeze(richFlow());
    const flow = parsed(input);
    const inputObjects = objectsOf(input);
    expect([...objectsOf(flow)].filter((o) => inputObjects.has(o))).toEqual([]);
    expect(Object.isFrozen(flow)).toBe(false);
    expect(Object.isFrozen(flow['nodes'])).toBe(false);
    expect(Object.isFrozen(flow['edges'])).toBe(false);
    expect(Object.isFrozen(get(flow, [...SRC, 'params']))).toBe(false);
    expect(Object.isFrozen(get(flow, [...FE, 'body', 'nodes']))).toBe(false);
  });

  it('T12: mutating every object of the result leaves the input unchanged', () => {
    const input = richFlow();
    const snapshot = JSON.stringify(input);
    const flow = parsed(input);
    for (const o of objectsOf(flow)) {
      if (Array.isArray(o)) o.push('mutated');
      else (o as Rec)['mutated'] = true;
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('T12: mutating the input after parsing leaves the result unchanged', () => {
    const input = richFlow();
    const result: ParseResult = parseFlow(input); // not `parsed(input)`: that deep-freezes the input, which could not be mutated
    if (!result.ok) throw new Error('expected ok');
    const flow = result.flow;
    const before = JSON.stringify(flow);
    for (const o of objectsOf(input)) {
      if (Array.isArray(o)) o.push('mutated');
      else (o as Rec)['mutated'] = true;
    }
    expect(JSON.stringify(flow)).toBe(before);
  });

  it('T12: two parses of one input share no object with each other', () => {
    const input = deepFreeze(richFlow());
    const a = parsed(input);
    const b = parsed(input);
    expect(a).not.toBe(b);
    const aObjects = objectsOf(a);
    expect([...objectsOf(b)].filter((o) => aObjects.has(o))).toEqual([]);
  });

  it('T12: a deep-frozen invalid input is not mutated either', () => {
    const input = deepFreeze(edit(richFlow(), [...FE, 'body', 'nodes', 'a', 'fn'], 5));
    expect(errorsOf(input).map((e) => e.path)).toEqual(['/nodes/fe/body/nodes/a/fn']);
    expect(canon(input)).toStrictEqual(canon(edit(richFlow(), [...FE, 'body', 'nodes', 'a', 'fn'], 5)));
  });

  it('T12: the same object used as two nodes or as two frame bodies parses fine', () => {
    const f = validFlow();
    const node = mapNode();
    edit(f, ['nodes', 'twin1'], node);
    edit(f, ['nodes', 'twin2'], node);
    edit(f, [...UN, 'body'], get(f, [...FE, 'body']));
    expect(parsed(f)['nodes']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Own-property semantics and prototype pollution
// ---------------------------------------------------------------------------------------------------------------------

const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();
const expectNoPollution = (): void => {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(PROTO_NAMES);
  expect(({} as Rec)['polluted']).toBeUndefined();
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
};

describe('T12: keys are own properties, nothing is read from or written to a prototype', () => {
  const HOSTILE = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', '__defineGetter__', '__lookupGetter__'];
  const source = (): Rec => ({ kind: 'source', fn: 'gen', out: { type: 'integer' } });

  it('T12: __proto__, constructor and hasOwnProperty are ordinary node ids in the outer graph and in bodies', () => {
    const nodes = Object.fromEntries(HOSTILE.map((id) => [id, source()]));
    const bodyNodes = Object.fromEntries(HOSTILE.map((id) => [id, mapNode()]));
    const input: Rec = { version: 1, id: 'f', name: 'f', nodes: { ...nodes, fe: { ...frameCommon('fe'), frame: 'foreach', concurrency: 1 } }, edges: [] };
    edit(input, [...FE, 'body', 'nodes'], bodyNodes);
    const flow = parsed(input);
    const out = flow['nodes'] as Rec;
    expect(Object.keys(out).sort()).toEqual([...HOSTILE, 'fe'].sort());
    const inner = get(flow, [...FE, 'body', 'nodes']) as Rec;
    expect(Object.keys(inner).sort()).toEqual([...HOSTILE].sort());
    for (const id of HOSTILE) {
      expect(Object.hasOwn(out, id), id).toBe(true);
      expect(canon(Object.getOwnPropertyDescriptor(out, id)?.value), id).toStrictEqual(canon(source()));
      expect(canon(Object.getOwnPropertyDescriptor(inner, id)?.value), id).toStrictEqual(canon(mapNode()));
    }
    expectNoPollution();
  });

  it('T12: errors under hostile node ids carry the id as an ordinary path segment and node name', () => {
    const nodes = Object.fromEntries(['__proto__', 'constructor', 'hasOwnProperty'].map((id) => [id, { kind: 'nope' }]));
    const errors = errorsOf({ version: 1, id: 'f', name: 'f', nodes, edges: [] });
    expect(errors.map((e) => [e.path, e.node])).toEqual([
      ['/nodes/__proto__/kind', '__proto__'],
      ['/nodes/constructor/kind', 'constructor'],
      ['/nodes/hasOwnProperty/kind', 'hasOwnProperty'],
    ]);
    expectNoPollution();
  });

  it('T12: hostile keys in properties, required, enum members, params and samples stay ordinary data', () => {
    const polluter = (): unknown => JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":1},"toString":"x"}');
    const schema = {
      type: 'object',
      properties: Object.fromEntries(HOSTILE.map((k) => [k, { type: 'string' }])),
      required: [...HOSTILE],
    };
    const input = edit(
      edit(edit(validFlow(), SRC_OUT, schema), [...MAP, 'in'], { enum: [polluter()] }),
      [...SRC, 'params'],
      polluter(),
    );
    edit(input, [...SNK, 'in'], { inferFrom: [polluter(), polluter()] });
    const flow = parsed(input);
    expect(pairs(get(flow, SRC_OUT))).toStrictEqual(pairs(schema));
    expect(Object.keys((get(flow, [...SRC_OUT, 'properties']) as Rec)).sort()).toEqual([...HOSTILE].sort());
    expect(pairs(get(flow, [...MAP, 'in']))).toStrictEqual(pairs({ enum: [polluter()] }));
    const params = get(flow, [...SRC, 'params']) as Rec;
    expect(Object.hasOwn(params, '__proto__')).toBe(true);
    expect(params['polluted']).toBeUndefined();
    expect(pairs(get(flow, [...SNK, 'in']))).toStrictEqual(pairs(inferSchema([polluter(), polluter()] as JsonValue[])));
    const inferred = get(flow, [...SNK, 'in']) as Rec;
    expect(Object.hasOwn(inferred['properties'] as Rec, '__proto__')).toBe(true);
    expect(((inferred['properties'] as Rec)['__proto__'] as Rec)['polluted']).toBeUndefined();
    expectNoPollution();
  });

  it('T12: rejected inputs full of hostile keys do not pollute either', () => {
    const polluter = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as unknown;
    errorsOf({ ...(polluter as Rec), version: 2 });
    errorsOf(edit(validFlow(), SRC_OUT, { ...(polluter as Rec), type: 'nope' }));
    errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: [polluter, undefined] }));
    errorsOf(JSON.parse('{"__proto__":{"polluted":true},"nodes":5}'));
    expectNoPollution();
  });

  it('T12: an object that inherits flow fields is not read through its prototype', () => {
    const inheriting = Object.create({ kind: 'sink', fn: 'f', in: {} }) as unknown;
    const r: ParseResult = parseFlow(edit(validFlow(), ['nodes', 'x'], inheriting));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.every((e) => e.code === 'E_SHAPE' && e.path.startsWith('/nodes/x'))).toBe(true);
    const schemaInheriting = Object.create({ type: 'string' }) as unknown;
    const r2: ParseResult = parseFlow(edit(validFlow(), SRC_OUT, schemaInheriting));
    expect(r2.ok).toBe(false);
  });

  it('T12: the Object.prototype is untouched after all of the above', () => {
    expectNoPollution();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Getters and Proxies: never an exception, never a hang
// ---------------------------------------------------------------------------------------------------------------------

describe('T12: throwing getters and Proxy inputs', () => {
  const boom = (flow: Rec, at: readonly string[], thrown: unknown = new Error('boom')): Rec => {
    const parent = get(flow, at.slice(0, -1)) as object;
    Object.defineProperty(parent, at[at.length - 1] as string, {
      enumerable: true,
      configurable: true,
      get() {
        throw thrown;
      },
    });
    return flow;
  };
  const withSamples = (): Rec => edit(validFlow(), SRC_OUT, { inferFrom: [1, { a: 1 }, [2]] });

  const cases: Array<[string, () => Rec, string, string | undefined]> = [
    ['version', () => boom(validFlow(), ['version']), '/version', undefined],
    ['id', () => boom(validFlow(), ['id']), '/id', undefined],
    ['name', () => boom(validFlow(), ['name']), '/name', undefined],
    ['nodes', () => boom(validFlow(), ['nodes']), '/nodes', undefined],
    ['edges', () => boom(validFlow(), ['edges']), '/edges', undefined],
    ['a node entry', () => boom(validFlow(), SRC), '/nodes/src', 'src'],
    ['a node kind', () => boom(validFlow(), [...SRC, 'kind']), '/nodes/src/kind', 'src'],
    ['a node fn', () => boom(validFlow(), [...SRC, 'fn']), '/nodes/src/fn', 'src'],
    ['node params', () => boom(validFlow(), [...SRC, 'params']), '/nodes/src/params', 'src'],
    ['a port', () => boom(validFlow(), SRC_OUT), '/nodes/src/out', 'src'],
    ['a schema keyword', () => boom(validFlow(), [...MAP, 'out', 'type']), '/nodes/m/out/type', 'm'],
    ['a property schema', () => boom(edit(validFlow(), SRC_OUT, { type: 'object', properties: { a: { type: 'string' } } }), [...SRC_OUT, 'properties', 'a']), '/nodes/src/out/properties/a', 'src'],
    ['a frame body', () => boom(validFlow(), [...FE, 'body']), '/nodes/fe/body', 'fe'],
    ['a body entry node', () => boom(validFlow(), [...FE, 'body', 'entry', 'node']), '/nodes/fe/body/entry/node', 'fe'],
    ['a nested frame field', () => boom(validFlow(), [...INNER, 'frame']), '/nodes/wh/body/nodes/inner/frame', 'wh.inner'],
    ['a budget', () => boom(validFlow(), [...FE, 'budgets', 'maxIterations']), '/nodes/fe/budgets/maxIterations', 'fe'],
    ['a semantic field', () => boom(validFlow(), [...FE, 'concurrency']), '/nodes/fe/concurrency', 'fe'],
    ['a backoff kind', () => boom(validFlow(), [...RT, 'backoff', 'kind']), '/nodes/rt/backoff/kind', 'rt'],
    ['an edge entry', () => boom(validFlow(), ['edges', '0']), '/edges/0', undefined],
    ['an edge port ref node', () => boom(validFlow(), ['edges', '0', 'from', 'node']), '/edges/0/from/node', undefined],
    ['the inferFrom array', () => boom(withSamples(), [...SRC_OUT, 'inferFrom']), '/nodes/src/out/inferFrom', 'src'],
    ['an inferFrom sample', () => boom(withSamples(), [...SRC_OUT, 'inferFrom', '0']), '/nodes/src/out/inferFrom/0', 'src'],
    ['a key of an inferFrom sample', () => boom(withSamples(), [...SRC_OUT, 'inferFrom', '1', 'a']), '/nodes/src/out/inferFrom/1/a', 'src'],
    ['an element of an inferFrom sample array', () => boom(withSamples(), [...SRC_OUT, 'inferFrom', '2', '0']), '/nodes/src/out/inferFrom/2/0', 'src'],
    ['an enum member', () => boom(edit(validFlow(), SRC_OUT, { enum: [1, 2] }), [...SRC_OUT, 'enum', '1']), '/nodes/src/out/enum/1', 'src'],
  ];

  it.each(cases)('T12: a throwing getter on %s is E_SHAPE at its path', (_name, make, path, node) => {
    const errors = errorsOf(make());
    expect(brief(errors)).toEqual([{ code: 'E_SHAPE', path }]);
    expect(errors[0]?.node).toBe(node);
  });

  it.each([
    ['an Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object without a message', { code: 7 }],
    ['an Error whose message getter throws', Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('nested'); } })],
  ])('T12: whatever a getter throws (%s), the result is E_SHAPE at the path, not an exception', (_name, thrown) => {
    expect(brief(errorsOf(boom(validFlow(), ['name'], thrown)))).toEqual([{ code: 'E_SHAPE', path: '/name' }]);
  });

  it('T12: several throwing getters and ordinary errors are all collected', () => {
    const f = boom(boom(edit(validFlow(), ['version'], 2), ['name']), [...SRC, 'fn']);
    expect(pathsOf(f)).toEqual(['/name', '/nodes/src/fn', '/version']);
  });

  it('T12: hostile values as bad fields never break message construction', () => {
    const hostile: unknown[] = [
      Symbol('s'),
      1n,
      Object.assign(Object.create(null), { a: 1 }),
      { toString: () => { throw new Error('toString'); } },
      { [Symbol.toPrimitive]: () => { throw new Error('toPrimitive'); } },
      { toJSON: () => { throw new Error('toJSON'); } },
      new Proxy({}, { get: () => { throw new Error('trap'); } }),
    ];
    for (const value of hostile) {
      for (const at of [['version'], ['id'], ['name'], [...SRC, 'kind'], [...SRC, 'fn'], [...FE, 'frame'], [...RT, 'onExhausted'], [...RT, 'backoff', 'kind'], [...FE, 'budgets', 'maxIterations'], [...FE, 'concurrency']]) {
        const r: ParseResult = parseFlow(edit(validFlow(), at, value));
        expect(r.ok, at.join('/')).toBe(false);
        if (!r.ok) {
          expect(r.errors.map((e) => e.code)).toEqual(['E_SHAPE']);
          expect(r.errors[0]?.path).toBe(`/${at.join('/')}`);
        }
      }
    }
  });

  const flipping = (values: unknown[]): { get: () => unknown } => {
    let reads = 0;
    return {
      get: () => {
        const v = values[Math.min(reads, values.length - 1)];
        reads++;
        return v;
      },
    };
  };
  const flip = (flow: Rec, at: readonly string[], values: unknown[]): Rec => {
    Object.defineProperty(get(flow, at.slice(0, -1)), at[at.length - 1] as string, { enumerable: true, configurable: true, ...flipping(values) });
    return flow;
  };

  it('T12: a getter whose value changes between reads can never make an invalid flow come back ok', () => {
    const cases: Array<[readonly string[], unknown[]]> = [
      [[...SRC, 'kind'], ['source', 'bogus']],
      [[...SRC, 'kind'], ['bogus', 'source']],
      [['version'], [1, 2]],
      [['version'], [2, 1]],
      [[...SRC, 'fn'], ['f', 5]],
      [SRC_OUT, [{ type: 'string' }, { type: 'nope' }, { type: 'nope' }]],
      [SRC_OUT, [{ type: 'nope' }, { type: 'string' }]],
      [[...MAP, 'out', 'type'], ['string', 'nope', 'nope']],
      [[...FE, 'budgets'], [{ maxIterations: 1 }, 5]],
      [[...FE, 'frame'], ['foreach', 'loop']],
      [['nodes'], [{}, 5]],
      [['edges'], [[], 'x']],
      [[...SRC, 'params'], [{ a: 1 }, () => 1]],
    ];
    for (const [at, values] of cases) {
      const r: ParseResult = parseFlow(flip(validFlow(), at, values));
      if (r.ok) {
        const again: ParseResult = parseFlow(r.flow);
        expect(again.ok, `${at.join('/')}: an ok result must itself parse ok`).toBe(true);
        if (again.ok) expect(canon(again.flow)).toStrictEqual(canon(r.flow));
      } else expectWellFormed(r.errors);
    }
  });

  it('T12: a transparent Proxy of a valid flow, of its arrays and of its nodes parses as its target', () => {
    const f = validFlow();
    f['edges'] = new Proxy(f['edges'] as unknown[], {});
    (f['nodes'] as Rec)['src'] = new Proxy((f['nodes'] as Rec)['src'] as object, {});
    const root = new Proxy(f, {});
    const r: ParseResult = parseFlow(root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(canon(r.flow)).toStrictEqual(canon(validFlow()));
  });

  it('T12: a Proxy whose get trap throws for one key is E_SHAPE at that key', () => {
    const root = new Proxy(validFlow(), {
      get: (t, k, rcv) => {
        if (k === 'id') throw new Error('trap');
        return Reflect.get(t, k, rcv);
      },
    });
    const r: ParseResult = parseFlow(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(brief(r.errors)).toEqual([{ code: 'E_SHAPE', path: '/id' }]);
  });

  it('T12: a revoked Proxy is E_SHAPE at its own path, as the root and as a node', () => {
    const revoked = (): object => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const root: ParseResult = parseFlow(revoked());
    expect(root.ok).toBe(false);
    if (!root.ok) expect(brief(root.errors)).toEqual([{ code: 'E_SHAPE', path: '' }]);
    const nested: ParseResult = parseFlow(edit(validFlow(), SRC, revoked()));
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(brief(nested.errors)).toEqual([{ code: 'E_SHAPE', path: '/nodes/src' }]);
  });

  it('T12: a root Proxy whose prototype cannot be read is E_SHAPE at the root', () => {
    const root = new Proxy(validFlow(), {
      getPrototypeOf: () => {
        throw new Error('trap');
      },
    });
    const r: ParseResult = parseFlow(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(brief(r.errors)).toEqual([{ code: 'E_SHAPE', path: '' }]);
  });

  it('T12: a Proxy whose ownKeys trap throws never throws out of parseFlow', () => {
    const throwing = (target: object): object =>
      new Proxy(target, {
        ownKeys: () => {
          throw new Error('trap');
        },
      });
    for (const input of [throwing(validFlow()), edit(validFlow(), ['nodes'], throwing({})), edit(validFlow(), SRC_OUT, throwing({ type: 'string' })), edit(validFlow(), SRC_OUT, { inferFrom: [throwing({ a: 1 })] })]) {
      const r: ParseResult = parseFlow(input);
      if (!r.ok) expectWellFormed(r.errors);
    }
  });

  it('T12: a Proxy that answers every property with itself terminates with E_SHAPE only', () => {
    const self: object = new Proxy({}, { get: () => self });
    const r: ParseResult = parseFlow(self);
    expect(r.ok).toBe(false);
    if (!r.ok) expectWellFormed(r.errors);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Cyclic and shared structures
// ---------------------------------------------------------------------------------------------------------------------

describe('T12: cyclic structures are E_SHAPE at the closing reference, shared (DAG) structures are fine', () => {
  const carriers: Array<[string, (v: unknown) => Rec, string]> = [
    ['an inferFrom sample', (v) => edit(validFlow(), SRC_OUT, { inferFrom: [1, 'a', null, v] }), '/nodes/src/out/inferFrom/3'],
    ['an enum member', (v) => edit(validFlow(), SRC_OUT, { enum: [1, 'a', null, v] }), '/nodes/src/out/enum/3'],
    ['params', (v) => edit(validFlow(), [...SRC, 'params'], v), '/nodes/src/params'],
  ];

  it.each(carriers)('T12: cycles inside %s are reported where they close', (_name, place, slot) => {
    const self: Rec = {};
    self['self'] = self;
    expect(brief(errorsOf(place(self)))).toEqual([{ code: 'E_SHAPE', path: `${slot}/self` }]);

    const arr: unknown[] = [1];
    arr.push(arr);
    expect(brief(errorsOf(place(arr)))).toEqual([{ code: 'E_SHAPE', path: `${slot}/1` }]);

    const chain: Rec = { b: { c: {} } };
    ((chain['b'] as Rec)['c'] as Rec)['back'] = chain;
    expect(brief(errorsOf(place(chain)))).toEqual([{ code: 'E_SHAPE', path: `${slot}/b/c/back` }]);

    const mid: Rec = { b: { c: {} } };
    ((mid['b'] as Rec)['c'] as Rec)['mid'] = mid['b'];
    expect(brief(errorsOf(place(mid)))).toEqual([{ code: 'E_SHAPE', path: `${slot}/b/c/mid` }]);

    const mixed: Rec = { list: [{ deeper: [] }] };
    (((mixed['list'] as unknown[])[0] as Rec)['deeper'] as unknown[]).push(mixed);
    expect(brief(errorsOf(place(mixed)))).toEqual([{ code: 'E_SHAPE', path: `${slot}/list/0/deeper/0` }]);
  });

  it.each(carriers)('T12: an object reachable twice in %s without being its own ancestor is valid', (_name, place) => {
    const shared = { a: [1, { b: null }] };
    const twice = [shared, shared, { x: shared, y: shared }];
    expect(parsed(place(twice))).toBeDefined();
    expect(parsed(place({ p: shared, q: shared }))).toBeDefined();
  });

  it('T12: a sample set that contains itself is reported at the element that closes it', () => {
    const samples: unknown[] = [1];
    samples.push(samples);
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: samples })))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out/inferFrom/1' }]);
  });

  it('T12: a bad sample reachable twice is reported at each path', () => {
    const bad = { z: undefined };
    expect(pathsOf(edit(validFlow(), SRC_OUT, { inferFrom: [bad, 1, { q: bad }] }))).toEqual(['/nodes/src/out/inferFrom/0/z', '/nodes/src/out/inferFrom/2/q/z']);
  });

  it('T12: self-referencing schemas are E_SHAPE at the closing reference, not a hang or a RangeError', () => {
    const array: Rec = { type: 'array' };
    array['items'] = array;
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, array)))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out/items' }]);

    const object: Rec = { type: 'object', properties: {} };
    (object['properties'] as Rec)['self'] = object;
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, object)))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out/properties/self' }]);

    const union: Rec = { anyOf: [] };
    (union['anyOf'] as unknown[]).push({ type: 'string' }, union);
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, union)))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out/anyOf/1' }]);

    const a: Rec = { type: 'array' };
    const b: Rec = { type: 'array', items: a };
    a['items'] = b;
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, a)))).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/out/items/items' }]);
  });

  it('T12: a schema object shared between siblings (not an ancestor) is valid', () => {
    const leaf = { type: 'string' };
    const schema = { type: 'object', properties: { a: leaf, b: leaf, c: { type: 'array', items: leaf } }, required: ['a'] };
    expect(canon(get(parsed(edit(validFlow(), SRC_OUT, schema)), SRC_OUT))).toStrictEqual(canon(schema));
  });

  it('T12: a body whose nodes record is the enclosing nodes record is E_SHAPE where it closes', () => {
    const f = validFlow();
    edit(f, [...FE, 'body', 'nodes'], f['nodes']);
    const errors = errorsOf(f);
    expect(brief(errors)).toEqual([{ code: 'E_SHAPE', path: '/nodes/fe/body/nodes' }]);
    expect(errors[0]?.node).toBe('fe');
  });

  it('T12: a frame that is its own body node is E_SHAPE where it closes', () => {
    const f = validFlow();
    edit(f, [...FE, 'body', 'nodes', 'me'], get(f, FE));
    const errors = errorsOf(f);
    expect(brief(errors)).toEqual([{ code: 'E_SHAPE', path: '/nodes/fe/body/nodes/me' }]);
    expect(errors[0]?.node).toBe('fe.me');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Robustness: unbounded nesting, huge inputs, linear time
// ---------------------------------------------------------------------------------------------------------------------
describe('T12: unbounded nesting does not overflow the stack', () => {
  const leafMap = (fn: unknown): Rec => ({ kind: 'map', fn, in: {}, out: { type: 'integer' } });

  it('T12: 20,000 nested frames parse ok and come back as deep', () => {
    const { depth, leaf } = peelFrames(parsed(nestedFrames(DEEP, leafMap('f'))));
    expect(depth).toBe(DEEP);
    expect(canon(leaf)).toStrictEqual(canon(leafMap('f')));
  }, 60_000);

  it('T12: an error 20,000 frames deep is reported with its exact path and scoped node id', () => {
    const errors = errorsOf(nestedFrames(DEEP, leafMap(5)));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('E_SHAPE');
    expect(errors[0]?.path).toBe(`/nodes/f${'/body/nodes/f'.repeat(DEEP)}/fn`);
    expect(errors[0]?.node).toBe(Array.from({ length: DEEP + 1 }, () => 'f').join('.'));
  }, 60_000);

  it.each(['arrays', 'objects', 'alternating'] as const)('T12: a schema %s 20,000 levels deep is accepted whole, and its error is at the exact path', (kind) => {
    const ok = deepSchema(kind, DEEP, { type: 'integer' });
    const { depth, leaf } = peelSchema(get(parsed(edit(validFlow(), SRC_OUT, ok.schema)), SRC_OUT));
    expect(depth).toBe(DEEP);
    expect(leaf).toEqual({ type: 'integer' });
    const bad = deepSchema(kind, DEEP, { type: 'date' });
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, bad.schema)))).toEqual([{ code: 'E_SHAPE', path: `/nodes/src/out${bad.suffix}/type` }]);
  }, 60_000);

  const jsonBuilders: Array<[string, (d: number, leaf: unknown) => unknown]> = [
    ['arrays', deepArrays],
    ['objects', deepObjects],
    ['alternating', deepAlternating],
  ];

  it.each(jsonBuilders)('T12: %s 20,000 levels deep are valid inferFrom samples, enum members and params', (_kind, build) => {
    const sample = build(DEEP, 1);
    const flow = parsed(edit(edit(edit(validFlow(), SRC_OUT, { inferFrom: [sample] }), [...MAP, 'in'], { enum: [build(DEEP, 'x')] }), [...SRC, 'params'], build(DEEP, null)));
    expect(peelJson(get(flow, [...SRC, 'params'])).depth).toBe(DEEP);
    expect(peelJson((get(flow, [...MAP, 'in', 'enum']) as unknown[])[0]).leaf).toBe('x');
    const inferred = peelSchema(get(flow, SRC_OUT));
    expect(inferred.depth).toBe(DEEP);
    expect(inferred.leaf).toEqual({ type: 'integer' });
  }, 60_000);

  it.each(jsonBuilders)('T12: a non-JSON leaf %s 20,000 levels deep is reported at its exact path', (_name, build) => {
    const leafPath = (v: unknown): string => {
      // the pointer from the root of `v` to its leaf: arrays step through index 0, objects through key a
      const parts: string[] = [];
      let cur = v;
      for (;;) {
        if (Array.isArray(cur)) {
          parts.push('/0');
          cur = cur[0];
        } else if (typeof cur === 'object' && cur !== null && 'a' in cur) {
          parts.push('/a');
          cur = (cur as Rec)['a'];
        } else return parts.join('');
      }
    };
    const value = build(DEEP, undefined);
    const expected = `/nodes/src/out/inferFrom/0${leafPath(value)}`;
    expect(expected.length).toBeGreaterThan(DEEP);
    expect(brief(errorsOf(edit(validFlow(), SRC_OUT, { inferFrom: [value] })))).toEqual([{ code: 'E_SHAPE', path: expected }]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Pins: what counts as a plain object, which keys are read, an array whose `length` lies
// ---------------------------------------------------------------------------------------------------------------------

describe('T12: pinned reading rules', () => {
  // The prototype's prototype is null: what a plain object of ANOTHER realm looks like, so it is plain too.
  const crossRealm = (v: Rec): Rec => Object.assign(Object.create(Object.create(null)) as Rec, v);
  const pointer = (at: readonly string[]): string => at.map((s) => `/${s}`).join('');
  const rejectedAt = (input: unknown, path: string): void => {
    const r = parseFlow(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual([path]);
  };

  it('T12: plain means a null prototype or a prototype whose own prototype is null (a cross-realm object is accepted)', () => {
    expect(canon(parsed(crossRealm(validFlow())))).toStrictEqual(canon(validFlow()));
    const viaSchema = edit(validFlow(), SRC_OUT, crossRealm({ type: 'integer' }));
    expect(canon(get(parsed(viaSchema), SRC_OUT))).toStrictEqual({ type: 'integer' });
    const viaParams = edit(validFlow(), [...SRC, 'params'], crossRealm({ a: [crossRealm({ b: 1 })] }));
    expect(canon(get(parsed(viaParams), [...SRC, 'params']))).toStrictEqual({ a: [{ b: 1 }] });
  });

  class Thing {}
  const notPlain: Array<[string, () => unknown]> = [
    ['a class instance', () => new Thing()],
    ['a Map', () => new Map()],
    ['a Date', () => new Date(0)],
    ['an object with a plain prototype', () => Object.create({}) as unknown],
  ];
  it.each(notPlain)('T12: %s is not plain, at the root, as params and as a schema', (_name, make) => {
    rejectedAt(make(), '');
    rejectedAt(edit(validFlow(), [...SRC, 'params'], make()), `/${SRC.join('/')}/params`);
    rejectedAt(edit(validFlow(), SRC_OUT, make()), `/${SRC_OUT.join('/')}`);
  });

  it('T12: non-enumerable own keys are ignored on the root, a node, a schema and params', () => {
    const hide = (o: unknown): void => void Object.defineProperty(o, 'extra', { value: 1, enumerable: false, configurable: true });
    const flow = validFlow();
    hide(flow);
    hide(get(flow, SRC));
    hide(get(flow, SRC_OUT));
    hide(get(flow, [...SRC, 'params']));
    const copy = parsed(flow);
    for (const o of [copy, get(copy, SRC), get(copy, SRC_OUT), get(copy, [...SRC, 'params'])]) {
      expect(Object.getOwnPropertyNames(o)).not.toContain('extra');
    }
    expect(canon(copy)).toStrictEqual(canon(validFlow()));
  });

  it.each(['extra', 'params', 'concurrency', 'name'])('T12: an enumerable key %s on Object.prototype is ignored', (key) => {
    Object.defineProperty(Object.prototype, key, { value: 1, enumerable: true, configurable: true, writable: true });
    try {
      const copy = parsed(validFlow());
      expect(canon(copy)).toStrictEqual(canon(validFlow()));
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
    expectNoPollution();
  });

  it('T12: the value of an unknown key is never read, and the key is one error', () => {
    const reads: string[] = [];
    const bomb = (o: unknown): unknown => {
      Object.defineProperty(o, 'bomb', {
        enumerable: true,
        get() {
          reads.push('bomb');
          return 1;
        },
      });
      return o;
    };
    for (const at of [[], SRC, SRC_OUT, [...FE, 'body'], [...FE, 'budgets'], ['edges', '0'], ['edges', '0', 'from']]) {
      const flow = validFlow();
      bomb(at.length === 0 ? flow : get(flow, at));
      expect(brief(errorsOf(flow))).toEqual([{ code: 'E_SHAPE', path: `${pointer(at)}/bomb` }]);
    }
    expect(reads).toEqual([]);
  });

  it.each([['x'], [Number.NaN], [-1], [1.5], [Number.POSITIVE_INFINITY], [null]])('T12: an array whose length is %s is E_SHAPE at its length', (length) => {
    const lying = (): unknown[] => new Proxy([], { get: (t, k, r) => (k === 'length' ? length : Reflect.get(t, k, r)) });
    // not frozen: a frozen target would make the get trap's lie a TypeError (a failed read) before the length is even checked
    const lengthErrors = (input: unknown): Array<{ code: string; path: string }> => {
      const r = parseFlow(input);
      return r.ok ? [] : brief(r.errors);
    };
    expect(lengthErrors(edit(validFlow(), ['edges'], lying()))).toEqual([{ code: 'E_SHAPE', path: '/edges/length' }]);
    const lying2 = parseFlow(edit(validFlow(), ['edges'], lying()));
    expect(lying2.ok ? '' : lying2.errors[0]?.message).toBe('array length must be a non-negative integer');
    expect(lengthErrors(edit(validFlow(), SRC_OUT, { anyOf: lying() }))).toEqual([{ code: 'E_SHAPE', path: `${pointer(SRC_OUT)}/anyOf/length` }]);
    expect(lengthErrors(edit(validFlow(), SRC_OUT, { inferFrom: [lying()] }))).toEqual([{ code: 'E_SHAPE', path: `${pointer(SRC_OUT)}/inferFrom/0/length` }]);
  });

  it('T12: 1,000,001 samples are all read: none is dropped at 1,000,000', () => {
    const samples: unknown[] = Array.from({ length: 1_000_001 }, (_, i) => (i === 1_000_000 ? 'last' : i));
    const flow = edit(edit(validFlow(), SRC_OUT, { inferFrom: samples }), [...SRC, 'params'], samples);
    const r = parseFlow(flow);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const copy = r.flow as unknown as Rec;
    const params = get(copy, [...SRC, 'params']) as unknown[];
    expect(params).toHaveLength(1_000_001);
    expect(params.at(-1)).toBe('last');
    expect(canon(get(copy, SRC_OUT))).toStrictEqual(canon(inferSchema(samples as JsonValue[])));
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Bounded work: parseFlow never throws or aborts, whatever the input claims to contain
// ---------------------------------------------------------------------------------------------------------------------
