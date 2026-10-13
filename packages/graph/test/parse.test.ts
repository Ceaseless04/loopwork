import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { inferSchema } from '../src/schema.js';
import type { JsonValue, ParseResult, ValidationError } from '../src/types.js';

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

type Rec = Record<string, unknown>;
const GONE = Symbol('gone');

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------------------------------

const budgets = (): Rec => ({ maxIterations: 100, maxDurationMs: 60_000, maxCostUsd: 1.5, maxTokens: 1000 });
const ref = (node: string, port: string): Rec => ({ node, port });
const edge = (fromNode: string, fromPort: string, toNode: string, toPort: string): Rec => ({
  from: ref(fromNode, fromPort),
  to: ref(toNode, toPort),
});
const mapNode = (): Rec => ({ kind: 'map', fn: 'dbl', in: { type: 'integer' }, out: { type: 'integer' }, concurrency: 2 });
const body = (scope: string, extraNodes: Rec = {}): Rec => ({
  nodes: { a: mapNode(), b: mapNode(), ...extraNodes },
  edges: [edge(`${scope}.a`, 'out', `${scope}.b`, 'in')],
  entry: ref(`${scope}.a`, 'in'),
  exit: ref(`${scope}.b`, 'out'),
});
const frameCommon = (scope: string, extraNodes?: Rec): Rec => ({
  kind: 'frame',
  budgets: budgets(),
  in: { type: 'array', items: { type: 'integer' } },
  out: { type: 'array', items: { type: 'integer' } },
  body: body(scope, extraNodes),
});

const validFlow = (): Rec => ({
  version: 1,
  id: 'flow-1',
  name: 'Flow One',
  nodes: {
    src: { kind: 'source', fn: 'gen', params: { n: 3, tags: ['a', null] }, out: { type: 'integer' } },
    m: mapNode(),
    snk: { kind: 'sink', fn: 'save', in: { type: 'integer' }, concurrency: 1 },
    fe: { ...frameCommon('fe'), frame: 'foreach', concurrency: 4 },
    wh: {
      ...frameCommon('wh', { inner: { ...frameCommon('wh.inner'), frame: 'foreach', concurrency: 2 } }),
      frame: 'while',
      condition: 'more',
    },
    un: { ...frameCommon('un'), frame: 'until', condition: 'done' },
    rt: {
      ...frameCommon('rt'),
      frame: 'retry',
      maxAttempts: 3,
      backoff: { kind: 'exponential', baseMs: 100 },
      onExhausted: 'emit-error',
    },
  },
  edges: [edge('src', 'out', 'm', 'in'), edge('m', 'out', 'snk', 'in')],
});

const SRC = ['nodes', 'src'];
const MAP = ['nodes', 'm'];
const SNK = ['nodes', 'snk'];
const FE = ['nodes', 'fe'];
const WH = ['nodes', 'wh'];
const UN = ['nodes', 'un'];
const RT = ['nodes', 'rt'];
const INNER = [...WH, 'body', 'nodes', 'inner'];
const SRC_OUT = [...SRC, 'out'];

// Every PortSpec position of validFlow.
const PORTS: string[][] = [
  SRC_OUT,
  [...MAP, 'in'],
  [...MAP, 'out'],
  [...SNK, 'in'],
  [...FE, 'in'],
  [...FE, 'out'],
  [...WH, 'in'],
  [...WH, 'out'],
  [...UN, 'in'],
  [...UN, 'out'],
  [...RT, 'in'],
  [...RT, 'out'],
  [...FE, 'body', 'nodes', 'a', 'in'],
  [...FE, 'body', 'nodes', 'b', 'out'],
  [...RT, 'body', 'nodes', 'a', 'in'],
  [...INNER, 'in'],
  [...INNER, 'out'],
  [...INNER, 'body', 'nodes', 'a', 'in'],
  [...INNER, 'body', 'nodes', 'b', 'out'],
];

const get = (root: unknown, at: readonly string[]): unknown => at.reduce<unknown>((cur, key) => (cur as Rec)[key], root);

const edit = (flow: Rec, at: readonly string[], value: unknown): Rec => {
  const last = at[at.length - 1];
  if (last === undefined) throw new Error('edit needs a non-empty location');
  const parent = get(flow, at.slice(0, -1)) as Rec;
  if (value === GONE) delete parent[last];
  else parent[last] = value;
  return flow;
};

// Freezes everything reachable (iteratively, cycle-safe, own data properties only), so any mutation by parseFlow throws.
const deepFreeze = <T>(root: T): T => {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || seen.has(v) || ArrayBuffer.isView(v)) continue;
    seen.add(v);
    for (const key of Reflect.ownKeys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (descriptor !== undefined && 'value' in descriptor) stack.push(descriptor.value);
    }
    Object.freeze(v);
  }
  return root;
};

// A canonical copy: own enumerable string keys only, sorted, `undefined`-valued keys kept, always plain objects.
// Two values are canon-equal exactly when they have the same own keys and the same leaves.
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Rec)[k])]));
  return v;
};

// canon as tagged, sorted [key, value] pairs. toStrictEqual also compares the `constructor` PROPERTY of both sides, which can
// never match for objects with an own `constructor` key (hostile data); pairs have no such key and stay strict (undefined
// values and the array/object distinction are kept).
const pairs = (v: unknown): unknown => {
  if (Array.isArray(v)) return ['array', v.map(pairs)];
  if (typeof v === 'object' && v !== null) return ['object', Object.keys(v).sort().map((k) => [k, pairs((v as Rec)[k])])];
  return v;
};

const run = (input: unknown): ParseResult => parseFlow(deepFreeze(input));
const parsed = (input: unknown): Rec => {
  const result: ParseResult = run(input);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors.slice(0, 3))}`);
  return result.flow as unknown as Rec;
};
const errorsOf = (input: unknown): ValidationError[] => {
  const result = run(input);
  expect(result.ok, 'parseFlow should reject this input').toBe(false);
  return result.ok ? [] : result.errors;
};
const brief = (errors: ValidationError[]): Array<{ code: string; path: string }> => errors.map((e) => ({ code: e.code, path: e.path }));
const pathsOf = (input: unknown): string[] => errorsOf(input).map((e) => e.path);

// The invariants of every failure: E_SHAPE only, messages, unique (code, path), sorted by path in plain string order.
const expectWellFormed = (errors: ValidationError[]): void => {
  expect(errors.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  errors.forEach((e, i) => {
    expect(e.code).toBe('E_SHAPE');
    expect(typeof e.message === 'string' && e.message.length > 0).toBe(true);
    expect(typeof e.path).toBe('string');
    if ('node' in e) expect(typeof e.node).toBe('string');
    const key = `${e.code} ${e.path}`;
    expect(seen.has(key), `duplicate error ${key}`).toBe(false);
    seen.add(key);
    const prev = errors[i - 1];
    if (prev !== undefined) expect(prev.path <= e.path, `${prev.path} must not come after ${e.path}`).toBe(true);
  });
};

const hasKeyDeep = (root: unknown, key: string): boolean => {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || seen.has(v)) continue;
    seen.add(v);
    if (Object.hasOwn(v, key)) return true;
    stack.push(...Object.values(v));
  }
  return false;
};

const objectsOf = (root: unknown): Set<object> => {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || seen.has(v)) continue;
    seen.add(v);
    for (const child of Object.values(v)) stack.push(child);
  }
  return seen;
};

type Rng = () => number;
const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const shuffled = <T>(rng: Rng, xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
};

const VALID_SCHEMAS: Rec[] = [
  {},
  { type: 'null' },
  { type: 'boolean' },
  { type: 'number' },
  { type: 'integer' },
  { type: 'string' },
  { type: 'array', items: {} },
  { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  { type: 'object', properties: {} },
  { type: 'object', properties: { a: { type: 'integer' }, b: { anyOf: [{ type: 'null' }, { type: 'string' }] } }, required: ['a'], additionalProperties: false },
  { type: 'object', properties: { a: {} }, required: [], additionalProperties: true },
  { anyOf: [{ type: 'string' }, { type: 'null' }, { anyOf: [{ type: 'boolean' }] }] },
  { enum: [1, 'a', null, [1, [2]], { a: true, b: { c: [] } }, false, -0.5] },
];

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

const DEEP = 20_000;
const WIDE = 100_000;

const deepArrays = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
const deepObjects = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
};
const deepAlternating = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? [v] : { a: v };
  return v;
};
const peelJson = (v: unknown): { depth: number; leaf: unknown } => {
  let depth = 0;
  let cur = v;
  for (;;) {
    if (Array.isArray(cur) && cur.length === 1) cur = cur[0];
    else if (typeof cur === 'object' && cur !== null && Object.keys(cur).length === 1 && 'a' in cur) cur = (cur as Rec)['a'];
    else return { depth, leaf: cur };
    depth++;
  }
};

// Schemas: `parts` is the pointer from the outermost schema to the leaf.
type DeepSchema = { schema: Rec; suffix: string };
const deepSchema = (kind: 'arrays' | 'objects' | 'alternating', depth: number, leaf: Rec): DeepSchema => {
  let schema = leaf;
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) {
    const asArray = kind === 'arrays' || (kind === 'alternating' && i % 2 === 0);
    schema = asArray ? { type: 'array', items: schema } : { type: 'object', properties: { a: schema }, required: ['a'] };
    parts.push(asArray ? '/items' : '/properties/a');
  }
  return { schema, suffix: parts.reverse().join('') };
};
const peelSchema = (s: unknown): { depth: number; leaf: unknown } => {
  let depth = 0;
  let cur = s;
  for (;;) {
    const r = cur as Rec;
    if (r['type'] === 'array') cur = r['items'];
    else if (r['type'] === 'object' && typeof r['properties'] === 'object' && 'a' in (r['properties'] as object)) cur = (r['properties'] as Rec)['a'];
    else return { depth, leaf: cur };
    depth++;
  }
};

const nestedFrames = (depth: number, leaf: Rec): Rec => {
  let node: Rec = leaf;
  for (let i = 0; i < depth; i++) {
    node = {
      kind: 'frame',
      frame: 'foreach',
      concurrency: 1,
      budgets: { maxIterations: 1, maxDurationMs: 1 },
      in: {},
      out: {},
      body: { nodes: { f: node }, edges: [], entry: ref('f', 'in'), exit: ref('f', 'out') },
    };
  }
  return { version: 1, id: 'deep', name: 'deep', nodes: { f: node }, edges: [] };
};
const peelFrames = (flow: Rec): { depth: number; leaf: unknown } => {
  let depth = 0;
  let cur: unknown = (flow['nodes'] as Rec)['f'];
  while ((cur as Rec)['kind'] === 'frame') {
    depth++;
    cur = (((cur as Rec)['body'] as Rec)['nodes'] as Rec)['f'];
  }
  return { depth, leaf: cur };
};

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

describe('T12: bounded work and bounded error count', () => {
  const MAX_ERRORS = 250_000;
  const MAX_WORK = 5_000_000;
  // No deep-freeze and no helper that walks the result: these inputs are large on purpose.
  const outcome = (input: unknown): ValidationError[] => {
    const r: ParseResult = parseFlow(input);
    expect(r.ok, 'a limit is never a false ok:true').toBe(false);
    return r.ok ? [] : r.errors;
  };
  // The one error a limit adds: at the root, whatever else was found.
  const limitError = (errors: ValidationError[], message: RegExp): void => {
    const at = errors.filter((e) => e.path === '');
    expect(at).toHaveLength(1);
    expect(at[0]?.code).toBe('E_SHAPE');
    expect(at[0]?.message).toMatch(message);
    expect(at[0]).not.toHaveProperty('node');
  };
  const pointer = (at: readonly string[]): string => at.map((p) => `/${p}`).join('');
  const TOO_LARGE = /input too large/;
  const TOO_MANY = /too many errors/;
  const withSamples = (samples: unknown): Rec => edit(validFlow(), SRC_OUT, { inferFrom: samples });
  const lyingLength = (length: number): unknown[] => new Proxy([], { get: (t, k, r) => (k === 'length' ? length : Reflect.get(t, k, r)) });
  const dagBomb = (levels: number): Rec => {
    let schema: Rec = { type: 'string' };
    for (let i = 0; i < levels; i++) schema = { anyOf: [schema, schema] };
    return edit(validFlow(), SRC_OUT, schema);
  };
  const badEdges = (n: number): Rec => ({ version: 1, id: 'f', name: 'f', nodes: {}, edges: Array.from({ length: n }, () => ({ from: ref('a', 'out') })) });

  it.each([1e8, 2 ** 32 - 1])('T12: a sparse array of length %s is one work-limit error, not an exception or an abort', (length) => {
    const errors = outcome(withSamples(new Array<unknown>(length)));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 10_000);

  it.each([1e9, 2 ** 53])('T12: a Proxy array that claims length %s is one work-limit error', (length) => {
    for (const input of [edit(validFlow(), ['edges'], lyingLength(length)), withSamples(lyingLength(length)), withSamples([1, lyingLength(length)])]) {
      const errors = outcome(input);
      expect(errors).toHaveLength(1);
      limitError(errors, TOO_LARGE);
    }
  }, 10_000);

  it.each([24, 40])('T12: a shared (DAG) schema %s levels deep is one work-limit error, not an exponential expansion', (levels) => {
    const errors = outcome(dagBomb(levels));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 20_000);

  it('T12: a small shared structure is still fully expanded and valid', () => {
    const copy = parsed(dagBomb(10));
    let depth = 0;
    for (let s = get(copy, SRC_OUT) as Rec; 'anyOf' in s; s = (s['anyOf'] as Rec[])[1] as Rec) depth++;
    expect(depth).toBe(10);
  });

  // The fixed cost of this flow is 20 work units (the root, the node and its params array: reads and container tasks), so
  // the largest params array that parses is MAX_WORK - 20 elements, one more is over: the limit is exact, neither off by
  // one nor padded.
  const withParams = (params: unknown): Rec => ({ version: 1, id: 'f', name: 'f', nodes: { s: { kind: 'source', fn: 'g', params, out: {} } }, edges: [] });
  it('T12: the work limit is exact: 4,999,980 params elements parse, one more is one limit error', () => {
    const under = new Array<number>(MAX_WORK - 20).fill(0);
    const r = parseFlow(withParams(under));
    expect(r.ok).toBe(true);
    if (r.ok) expect(((r.flow.nodes['s'] as Rec)['params'] as unknown[]).length).toBe(under.length);
    under.push(0);
    limitError(outcome(withParams(under)), TOO_LARGE);
    limitError(outcome(withParams(new Array<number>(MAX_WORK).fill(0))), TOO_LARGE);
  }, 60_000);

  it('T12: the work of several values adds up, and a list longer than what is left is refused before any element is read', () => {
    // 4,000,000 of the budget are used by the first source; the second claims 2,000,000 more and must not be read at all
    let indexReads = 0;
    const counting = new Proxy(new Array<number>(2_000_000).fill(0), {
      get: (t, k, r) => {
        if (typeof k === 'string' && /^\d+$/.test(k)) indexReads++;
        return Reflect.get(t, k, r);
      },
    });
    const sources = { a: { kind: 'source', fn: 'g', params: new Array<number>(4_000_000).fill(0), out: {} }, b: { kind: 'source', fn: 'g', params: counting, out: {} } };
    limitError(outcome({ version: 1, id: 'f', name: 'f', nodes: sources, edges: [] }), TOO_LARGE);
    expect(indexReads).toBe(0);
    const shared = new Array<number>(2_000_000).fill(0);
    const sum: Rec = { version: 1, id: 'f', name: 'f', nodes: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { kind: 'source', fn: 'g', params: shared, out: {} }])), edges: [] };
    limitError(outcome(sum), TOO_LARGE);
  }, 60_000);

  it('T12: errors up to the limit are all reported, with no extra error', () => {
    const errors = outcome(badEdges(MAX_ERRORS));
    expect(errors).toHaveLength(MAX_ERRORS);
    expect(errors.some((e) => e.path === '')).toBe(false);
    expect(errors.map((e) => e.path)).toEqual(Array.from({ length: MAX_ERRORS }, (_, i) => `/edges/${i}/to`).sort());
  }, 60_000);

  it('T12: past the error limit the first errors stay, then one limit error at the root, sorted and unique', () => {
    for (const n of [MAX_ERRORS + 1, 400_000]) {
      const errors = outcome(badEdges(n));
      expect(errors).toHaveLength(MAX_ERRORS + 1);
      limitError(errors, TOO_MANY);
      expect(errors[0]?.path).toBe('');
      expect(errors.slice(1).map((e) => e.path)).toEqual(Array.from({ length: MAX_ERRORS }, (_, i) => `/edges/${i}/to`).sort());
      expect(new Set(errors.map((e) => e.path)).size).toBe(errors.length);
    }
  }, 60_000);

  it('T12: 300,000 unknown keys on one object stop at the error limit too', () => {
    const flow: Rec = validFlow();
    for (let i = 0; i < 300_000; i++) flow[`k${i}`] = i;
    const errors = outcome(flow);
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
  }, 60_000);

  it('T12: a limit never hides behind an ok result: even with no other error the result is not ok', () => {
    expect(parseFlow(withSamples(new Array<unknown>(2 ** 32 - 1))).ok).toBe(false);
  }, 20_000);

  // --- the text of the errors is work too -------------------------------------------------------------------------------

  const jsonSchemaChain = (n: number): unknown =>
    JSON.parse(`{"version":1,"id":"x","name":"x","edges":[],"nodes":{"s":{"kind":"source","fn":"g","out":${'{"type":"array","x":1,"items":'.repeat(n)}{"type":"integer"}${'}'.repeat(n)}}}}`);
  const jsonFrameChain = (n: number): unknown => {
    const open = '{"kind":"frame","frame":"foreach","budgets":{},"in":{},"body":{"edges":[],"entry":{"node":"f","port":"in"},"exit":{"node":"f","port":"out"},"nodes":{"f":';
    return JSON.parse(`{"version":1,"id":"x","name":"x","edges":[],"nodes":{"f":${open.repeat(n)}{"kind":"map","fn":"g","in":{},"out":{}}${'}}}'.repeat(n)}}}`);
  };
  const withinSeconds = (seconds: number, run: () => ValidationError[]): ValidationError[] => {
    const start = Date.now();
    const errors = run();
    expect(Date.now() - start).toBeLessThan(seconds * 1000);
    return errors;
  };
  // What is kept is bounded: the characters of the recorded errors stay near the work limit (each error may carry a little free).
  const expectBoundedText = (errors: ValidationError[]): void => {
    const chars = errors.reduce((sum, e) => sum + e.path.length + e.message.length + (e.node?.length ?? 0), 0);
    expect(chars).toBeLessThan(MAX_WORK + 300 * errors.length);
  };

  it.each([10_000, 30_000])('T12: an error at every level of a %s-deep schema is bounded by the work limit', (depth) => {
    const errors = withinSeconds(5, () => outcome(jsonSchemaChain(depth)));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it.each([10_000, 30_000])('T12: an error at every level of %s nested frames is bounded by the work limit', (depth) => {
    const errors = withinSeconds(5, () => outcome(jsonFrameChain(depth)));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it('T12: a 1,000,000-character id under 1,000 errors is bounded by the work limit', () => {
    const id = 'x'.repeat(1_000_000);
    const out = { anyOf: Array.from({ length: 1_000 }, () => ({ type: 'x' })) };
    const errors = withinSeconds(5, () => outcome({ version: 1, id: 'f', name: 'f', nodes: { [id]: { kind: 'source', fn: 'g', out } }, edges: [] }));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it('T12: ordinary error text is free: the limits count values and errors, not the characters of normal paths', () => {
    // a 100-character id and 1,000 errors under it: all kept, no limit error
    const out = { anyOf: Array.from({ length: 1_000 }, () => ({ type: 'x' })) };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { ['n'.repeat(100)]: { kind: 'source', fn: 'g', out } }, edges: [] });
    expect(errors).toHaveLength(1_000);
  });

  // --- shared (DAG) structures made of OBJECTS: the main loop itself must stop ----------------------------------------

  it.each([24, 40])('T12: shared object structures %s levels deep (params, schema properties) are one work-limit error', (levels) => {
    let value: unknown = 1;
    let schema: Rec = { type: 'string' };
    for (let i = 0; i < levels; i++) {
      value = { a: value, b: value };
      schema = { type: 'object', properties: { a: schema, b: schema } };
    }
    for (const input of [edit(validFlow(), [...SRC, 'params'], value), edit(validFlow(), SRC_OUT, schema)]) {
      const errors = withinSeconds(8, () => outcome(input));
      expect(errors).toHaveLength(1);
      limitError(errors, TOO_LARGE);
    }
  }, 30_000);

  // --- what happens after a limit fires ---------------------------------------------------------------------------------

  it('T12: after the work limit fires nothing more is recorded, not even from the object being read', () => {
    // body.edges trips the limit; the body's missing entry/exit and the frame's missing budgets/in/out come after it
    const frame = { kind: 'frame', frame: 'foreach', body: { nodes: {}, edges: new Array<unknown>(1e8) } };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { fe: frame }, edges: [] });
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 10_000);

  it('T12: the first limit wins: the error limit, then more work, is still the error limit', () => {
    // 1,500,000 edges: the 250,001st error stops the parse, but the edges already queued push the work past 5,000,000
    const errors = outcome(badEdges(1_500_000));
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
  }, 60_000);

  it('T12: with the error limit hit, the errors kept are the first in document order', () => {
    const nodes: Rec = {};
    for (let i = 0; i < 300_000; i++) nodes[`n${String(i).padStart(6, '0')}`] = { kind: 'nope' };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes, edges: [] });
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
    expect(errors[1]?.path).toBe('/nodes/n000000/kind');
    expect(errors.at(-1)?.path).toBe(`/nodes/n${String(MAX_ERRORS - 1).padStart(6, '0')}/kind`);
  }, 60_000);

  it('T12: the same order holds for schema properties, list members and JSON values', () => {
    const many = (n: number, bad: unknown): Rec => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(6, '0')}`, bad]));
    const props = outcome(edit(validFlow(), SRC_OUT, { type: 'object', properties: many(MAX_ERRORS + 10, { type: 'x' }) }));
    expect(props[1]?.path).toBe(`${pointer(SRC_OUT)}/properties/k000000/type`);
    const json = outcome(edit(validFlow(), [...SRC, 'params'], Array.from({ length: MAX_ERRORS + 10 }, () => undefined)));
    expect(json[1]?.path).toBe(`${pointer([...SRC, 'params'])}/0`);
  }, 60_000);

  it('T12: a node of unknown kind that holds a flow word reports that key as well as the kind', () => {
    for (const word of ['id', 'version', 'name', 'nodes']) {
      const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { x: { kind: 'bogus', [word]: 1 } }, edges: [] });
      expect(errors.map((e) => e.path)).toEqual([`/nodes/x/${word}`, '/nodes/x/kind'].sort());
    }
  });

  // --- the length of a key is work too ----------------------------------------------------------------------------------

  it('T12: a shared (DAG) structure with a 1,000,000-character key is one work-limit error', () => {
    let params: Rec = { ['a'.repeat(1_000_000)]: 1 };
    for (let i = 0; i < 19; i++) params = { a: params, b: params };
    const errors = withinSeconds(5, () => outcome(edit(validFlow(), [...SRC, 'params'], params)));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 20_000);

  it('T12: keys up to 256 characters are free: 21,000 keys of 256 characters parse', () => {
    const params = Object.fromEntries(Array.from({ length: 21_000 }, (_, i) => [String(i).padStart(256, 'k'), i]));
    const r = parseFlow(edit(validFlow(), [...SRC, 'params'], params));
    expect(r.ok).toBe(true);
  }, 20_000);

  // --- a node whose keys cannot be read -------------------------------------------------------------------------------

  it('T12: a node whose ownKeys trap throws is E_SHAPE at the node', () => {
    const node = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    const r = parseFlow({ version: 1, id: 'f', name: 'f', nodes: { x: node }, edges: [] });
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.node])).toEqual([['/nodes/x', 'x']]);
  });

  it('T12: a node without kind has a missing kind, an unknown kind is an expected-one-of error', () => {
    const at = (node: Rec): ValidationError[] => outcome({ version: 1, id: 'f', name: 'f', nodes: { x: node }, edges: [] });
    expect(at({})).toMatchObject([{ path: '/nodes/x/kind', message: 'missing field' }]);
    expect(at({ kind: 'bogus' })).toMatchObject([{ path: '/nodes/x/kind', message: expect.stringContaining('expected one of') as unknown }]);
    expect(at({ kind: undefined })).toMatchObject([{ path: '/nodes/x/kind', message: expect.stringContaining('expected one of') as unknown }]);
  });
});
