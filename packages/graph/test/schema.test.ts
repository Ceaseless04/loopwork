import { describe, expect, it } from 'vitest';
import { conformsTo, inferSchema, isAssignable } from '../src/schema.js';
import type { JsonValue, Schema } from '../src/types.js';

// Pinned semantic decisions (the spec is silent on these; the implementation follows the tests):
//  - inferSchema output is canonical: `required` is ALWAYS present (sorted, possibly empty); anyOf members are
//    deduplicated by kind and ordered null, boolean, integer|number, string, array, object; never nested, never `{}`.
//  - conformsTo uses OWN-property semantics for keys; NaN and the infinities fail `number` and `integer`.
//  - isAssignable is sound (no false positives) and deliberately incomplete; see the anyOf false-negative tests.

// ---------------------------------------------------------------------------------------------------------------------
// Schema builders and accessors
// ---------------------------------------------------------------------------------------------------------------------

type ObjectSchema = Extract<Schema, { type: 'object' }>;
type ArraySchema = Extract<Schema, { type: 'array' }>;

const ANY: Schema = {};
const NUL: Schema = { type: 'null' };
const BOOL: Schema = { type: 'boolean' };
const NUM: Schema = { type: 'number' };
const INT: Schema = { type: 'integer' };
const STR: Schema = { type: 'string' };
const PRIMITIVES: Schema[] = [NUL, BOOL, NUM, INT, STR];

const arr = (items: Schema): Schema => ({ type: 'array', items });
const anyOf = (...members: Schema[]): Schema => ({ anyOf: members });
const en = (...values: JsonValue[]): Schema => ({ enum: values });
const obj = (properties: Record<string, Schema>, required?: string[], additionalProperties?: boolean): Schema => ({
  type: 'object',
  properties,
  ...(required === undefined ? {} : { required }),
  ...(additionalProperties === undefined ? {} : { additionalProperties }),
});

const isArraySchema = (s: Schema): s is ArraySchema => 'type' in s && s.type === 'array';
const isObjectSchema = (s: Schema): s is ObjectSchema => 'type' in s && s.type === 'object';
const isAnyOfSchema = (s: Schema): s is { anyOf: Schema[] } => 'anyOf' in s;
const isEnumSchema = (s: Schema): s is { enum: JsonValue[] } => 'enum' in s;
const requiredOf = (s: Schema): string[] => (isObjectSchema(s) ? (s.required ?? []) : []);
const propsOf = (s: Schema): Record<string, Schema> => (isObjectSchema(s) ? s.properties : {});

const hasOwn = (o: object, key: string): boolean => Object.hasOwn(o, key);
const json = (v: unknown): string => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic pseudo-randomness (no dependency): mulberry32
// ---------------------------------------------------------------------------------------------------------------------

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

const pick = <T>(rng: Rng, xs: readonly T[]): T => {
  const x = xs[Math.floor(rng() * xs.length)];
  if (x === undefined) throw new Error('pick from an empty pool');
  return x;
};

const shuffled = <T>(rng: Rng, xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) throw new Error('unreachable');
    out[i] = b;
    out[j] = a;
  }
  return out;
};

const KEYS = ['a', 'b', 'c'];
const WORDS = ['', 'a', 'b', 'hello'];
const ENUM_POOL: JsonValue[] = [null, true, false, 0, 1, 2, 1.5, 'a', 'b', [], [1], {}, { a: 1 }];

const genObjectValue = (rng: Rng, depth: number): Record<string, JsonValue> => {
  const out: Record<string, JsonValue> = {};
  for (const key of KEYS) if (rng() < 0.6) out[key] = genJson(rng, depth - 1);
  return out;
};
const genArrayValue = (rng: Rng, depth: number): JsonValue[] =>
  Array.from({ length: Math.floor(rng() * 4) }, () => genJson(rng, depth - 1));

function genJson(rng: Rng, depth: number): JsonValue {
  const k = Math.floor(rng() * (depth > 0 ? 8 : 5));
  if (k === 0) return null;
  if (k === 1) return rng() < 0.5;
  if (k === 2) return Math.floor(rng() * 11) - 5;
  if (k === 3) return (Math.floor(rng() * 21) - 10) / 4;
  if (k === 4) return pick(rng, WORDS);
  if (k <= 6) return genArrayValue(rng, depth);
  return genObjectValue(rng, depth);
}

// A random sample set: mixed kinds, or homogeneous objects / arrays / numbers (so merges, not just anyOf, get exercised).
const genSamples = (rng: Rng): JsonValue[] => {
  const n = 1 + Math.floor(rng() * 6);
  const kind = Math.floor(rng() * 4);
  return Array.from({ length: n }, (): JsonValue => {
    if (kind === 1) return genObjectValue(rng, 3);
    if (kind === 2) return genArrayValue(rng, 3);
    if (kind === 3) return (Math.floor(rng() * 9) - 4) / (rng() < 0.5 ? 1 : 2);
    return genJson(rng, 3);
  });
};

// Random schemas. Never empty anyOf/enum. A closed object may require a key it does not define ('d'): such a schema
// accepts nothing (see genFor), which is exactly where an unsound "unsatisfiable target" rule would show.
function genSchema(rng: Rng, depth: number): Schema {
  const k = Math.floor(rng() * (depth > 0 ? 13 : 9));
  if (k === 0) return ANY;
  if (k === 1) return NUL;
  if (k === 2) return BOOL;
  if (k === 3) return NUM;
  if (k === 4) return INT;
  if (k === 5) return STR;
  if (k <= 8) return { enum: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(rng, ENUM_POOL)) };
  if (k <= 10) return arr(genSchema(rng, depth - 1));
  if (k === 11) {
    const properties: Record<string, Schema> = {};
    for (const key of KEYS) if (rng() < 0.5) properties[key] = genSchema(rng, depth - 1);
    const r = rng();
    const additionalProperties = r < 0.4 ? undefined : r < 0.6;
    const required = Object.keys(properties).filter(() => rng() < 0.5);
    if (rng() < 0.15) required.push('d');
    return obj(properties, rng() < 0.2 ? undefined : required, additionalProperties);
  }
  return anyOf(...Array.from({ length: 1 + Math.floor(rng() * 3) }, () => genSchema(rng, depth - 1)));
}

// A value that the schema accepts, or undefined when it accepts nothing (a closed object requiring a key it does not
// define, or one whose required property is itself unsatisfiable). Open objects get extra properties with arbitrary
// values, including under keys the schema omits: that is exactly where unsound width rules would be caught.
function genFor(s: Schema, rng: Rng): JsonValue | undefined {
  if (isAnyOfSchema(s)) {
    for (const member of shuffled(rng, s.anyOf)) {
      const value = genFor(member, rng);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  if (isEnumSchema(s)) return pick(rng, s.enum);
  if (isArraySchema(s)) {
    const out: JsonValue[] = [];
    for (let i = Math.floor(rng() * 4); i > 0; i--) {
      const item = genFor(s.items, rng);
      if (item === undefined) break;
      out.push(item);
    }
    return out;
  }
  if (isObjectSchema(s)) {
    const out: Record<string, JsonValue> = {};
    const required = s.required ?? [];
    for (const [key, prop] of Object.entries(s.properties)) {
      if (!required.includes(key) && rng() >= 0.5) continue;
      const value = genFor(prop, rng);
      if (value !== undefined) out[key] = value;
      else if (required.includes(key)) return undefined;
    }
    for (const key of required) {
      if (hasOwn(out, key)) continue;
      if (s.additionalProperties === false) return undefined;
      out[key] = genJson(rng, 1);
    }
    if (s.additionalProperties !== false) {
      for (const key of [...KEYS, 'd']) if (!hasOwn(out, key) && !hasOwn(s.properties, key) && rng() < 0.5) out[key] = genJson(rng, 1);
      for (const key of KEYS) if (!hasOwn(out, key) && !hasOwn(s.properties, key) && rng() < 0.3) out[key] = genJson(rng, 1);
    }
    return out;
  }
  const type = 'type' in s ? s.type : undefined;
  if (type === 'null') return null;
  if (type === 'boolean') return rng() < 0.5;
  if (type === 'integer') return pick(rng, [0, 1, -2, 7]);
  if (type === 'number') return pick(rng, [0, 1, -2, 1.5, 2.25, 10]);
  if (type === 'string') return pick(rng, WORDS);
  return genJson(rng, 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------------------------------------------------

const HAND_SCHEMAS: Schema[] = [
  ANY, NUL, BOOL, NUM, INT, STR,
  en(1), en(1, 2), en('a'), en('a', 'b'), en(null), en(true, false), en({ a: 1 }), en([1]),
  arr(ANY), arr(INT), arr(NUM), arr(STR), arr(arr(INT)), arr(arr(NUM)), arr(en(1)), arr(anyOf(INT, STR)),
  obj({}), obj({ a: INT }), obj({ a: NUM }), obj({ a: INT }, ['a']), obj({ a: NUM }, ['a']),
  obj({ a: INT, b: STR }, ['a']), obj({ a: INT }, ['a'], false), obj({ a: INT, b: STR }, ['a'], false), obj({}, [], false),
  obj({}, ['a'], false), // accepts nothing: a closed object requiring a key it does not define
  obj({ o: obj({ x: INT }, ['x']) }, ['o']), obj({ o: obj({ x: NUM }) }), obj({ a: anyOf(INT, NUL) }), obj({ a: en(1) }, ['a']),
  anyOf(INT, STR), anyOf(NUM, STR), anyOf(NUM, STR, NUL), anyOf(NUL, obj({ a: INT }, ['a'])), anyOf(arr(INT), STR), anyOf(en('a'), en('b')),
];

let corpusCache: Schema[] | undefined;
const buildCorpus = (): Schema[] => {
  if (corpusCache !== undefined) return corpusCache;
  const rng = mulberry32(0x5c4e3a);
  const schemas = [...HAND_SCHEMAS];
  for (let i = 0; i < 45; i++) schemas.push(genSchema(rng, 2));
  const sampleRng = mulberry32(0x1abe1);
  for (let i = 0; i < 25; i++) schemas.push(inferSchema(genSamples(sampleRng)));
  const seen = new Map<string, Schema>();
  for (const s of schemas) seen.set(json(s), s);
  corpusCache = [...seen.values()];
  return corpusCache;
};

// ---------------------------------------------------------------------------------------------------------------------
// Walk and invariants of inferred schemas
// ---------------------------------------------------------------------------------------------------------------------

const walk = (s: Schema, visit: (s: Schema) => void): void => {
  visit(s);
  if (isArraySchema(s)) walk(s.items, visit);
  else if (isObjectSchema(s)) for (const p of Object.values(s.properties)) walk(p, visit);
  else if (isAnyOfSchema(s)) for (const m of s.anyOf) walk(m, visit);
};

const KIND_RANK = ['null', 'boolean', 'number', 'string', 'array', 'object'];
const kindOf = (s: Schema): string => {
  if (isArraySchema(s)) return 'array';
  if (isObjectSchema(s)) return 'object';
  const t = 'type' in s ? s.type : undefined;
  return t === 'integer' ? 'number' : typeof t === 'string' ? t : 'other';
};

const inferredViolations = (root: Schema): string[] => {
  const out: string[] = [];
  walk(root, (s) => {
    if (isEnumSchema(s)) out.push('enum emitted');
    if (isObjectSchema(s)) {
      if (hasOwn(s, 'additionalProperties')) out.push('additionalProperties emitted');
      const required = s.required;
      if (required === undefined) out.push('required missing');
      else {
        if (json(required) !== json([...required].sort())) out.push(`required not sorted: ${json(required)}`);
        for (const k of required) if (!hasOwn(s.properties, k)) out.push(`required key without property: ${k}`);
      }
    }
    if (isAnyOfSchema(s)) {
      if (s.anyOf.length < 2) out.push('anyOf with fewer than two members');
      const ranks = s.anyOf.map((m) => KIND_RANK.indexOf(kindOf(m)));
      for (let i = 0; i < ranks.length; i++) {
        const rank = ranks[i];
        const prev = ranks[i - 1];
        if (rank === undefined || rank < 0) out.push(`bad anyOf member ${json(s.anyOf[i])}`);
        else if (prev !== undefined && prev >= rank) out.push(`anyOf members not strictly ordered by kind: ${json(s.anyOf)}`);
      }
    }
  });
  return out;
};

const deepFreeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
};

type Row = readonly [from: Schema, to: Schema, expected: boolean];
const assignabilityMisses = (rows: readonly Row[]): string[] =>
  rows.filter(([from, to, expected]) => isAssignable(from, to) !== expected).map(([from, to, expected]) => `${json(from)} -> ${json(to)}: expected ${String(expected)}`);

const conformanceMisses = (rows: ReadonlyArray<readonly [JsonValue, Schema, boolean]>): string[] =>
  rows.filter(([value, schema, expected]) => conformsTo(value, schema) !== expected).map(([value, schema, expected]) => `${json(value)} ~ ${json(schema)}: expected ${String(expected)}`);

// ---------------------------------------------------------------------------------------------------------------------
// GM-6: inferSchema
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-6: inferSchema', () => {
  it('GM-6: inferSchema merges 1 and 2.5 into number', () => {
    expect(inferSchema([1, 2.5])).toEqual(NUM);
    expect(inferSchema([2.5, 1])).toEqual(NUM);
    expect(inferSchema([1, 2, 2.5, 3])).toEqual(NUM);
  });

  it('GM-6: all-integer samples give integer, any non-integer number gives number', () => {
    expect(inferSchema([1])).toEqual(INT);
    expect(inferSchema([1, 2, -3, 0])).toEqual(INT);
    expect(inferSchema([1.0, 2.0])).toEqual(INT);
    expect(inferSchema([1000])).toEqual(INT);
    expect(inferSchema([0.5])).toEqual(NUM);
    expect(inferSchema([-0.25, -1])).toEqual(NUM);
  });

  it('GM-6: empty samples give the any-schema {}', () => {
    const s = inferSchema([]);
    expect(s).toEqual({});
    expect(Object.keys(s)).toEqual([]);
  });

  it('GM-6: strings, booleans and null give their primitive schema', () => {
    expect(inferSchema(['a', 'b', ''])).toEqual(STR);
    expect(inferSchema([true, false])).toEqual(BOOL);
    expect(inferSchema([true])).toEqual(BOOL);
    expect(inferSchema([null, null])).toEqual(NUL);
    expect(inferSchema([null])).toEqual(NUL);
  });

  it('GM-6: mixed kinds give anyOf, deduplicated, never enum', () => {
    expect(inferSchema([1, 'a'])).toEqual(anyOf(INT, STR));
    expect(inferSchema(['a', 1])).toEqual(anyOf(INT, STR));
    expect(inferSchema([1, 'a', 'b', 2, 'c'])).toEqual(anyOf(INT, STR));
    expect(inferSchema([true, 'x'])).toEqual(anyOf(BOOL, STR));
    expect(inferSchema(['a', 'a', 'a'])).toEqual(STR);
  });

  it('GM-6: integer and number collapse to number inside anyOf', () => {
    expect(inferSchema([1, 2.5, 'a'])).toEqual(anyOf(NUM, STR));
    expect(inferSchema(['a', 2.5, 1])).toEqual(anyOf(NUM, STR));
    expect(inferSchema([{ a: 1 }, { a: 2.5 }, { a: 'x' }])).toEqual(obj({ a: anyOf(NUM, STR) }, ['a']));
  });

  it('GM-6: null plus another kind gives anyOf including the null schema', () => {
    expect(inferSchema([null, 1])).toEqual(anyOf(NUL, INT));
    expect(inferSchema([1, null])).toEqual(anyOf(NUL, INT));
    expect(inferSchema(['a', null, 'b'])).toEqual(anyOf(NUL, STR));
    expect(inferSchema([null, { a: 1 }])).toEqual(anyOf(NUL, obj({ a: INT }, ['a'])));
    expect(inferSchema([{ a: null }, { a: 1 }])).toEqual(obj({ a: anyOf(NUL, INT) }, ['a']));
  });

  it('GM-6: anyOf members have a fixed order: null, boolean, number, string, array, object', () => {
    const everyKind: JsonValue[] = ['x', 1.5, true, null, [1], { a: 1 }];
    const expected = anyOf(NUL, BOOL, NUM, STR, arr(INT), obj({ a: INT }, ['a']));
    expect(inferSchema(everyKind)).toEqual(expected);
    expect(inferSchema([...everyKind].reverse())).toEqual(expected);
    expect(inferSchema(shuffled(mulberry32(7), everyKind))).toEqual(expected);
    // each adjacent pair of ranks, so no single swap of the rank table goes unnoticed
    expect(inferSchema([[1], { a: 1 }])).toEqual(anyOf(arr(INT), obj({ a: INT }, ['a'])));
    expect(inferSchema([{ a: 1 }, [1]])).toEqual(anyOf(arr(INT), obj({ a: INT }, ['a'])));
    expect(inferSchema(['s', [1]])).toEqual(anyOf(STR, arr(INT)));
    expect(inferSchema([[1], 's'])).toEqual(anyOf(STR, arr(INT)));
    expect(inferSchema([2, 's'])).toEqual(anyOf(INT, STR));
    expect(inferSchema(['s', 2])).toEqual(anyOf(INT, STR));
    expect(inferSchema([true, 2])).toEqual(anyOf(BOOL, INT));
    expect(inferSchema([2, true])).toEqual(anyOf(BOOL, INT));
    expect(inferSchema([null, true])).toEqual(anyOf(NUL, BOOL));
    expect(inferSchema([true, null])).toEqual(anyOf(NUL, BOOL));
  });

  it('GM-6: arrays and objects among mixed kinds each merge into one member', () => {
    expect(inferSchema([[1], { a: 1 }, [2.5], { b: 'x' }])).toEqual(anyOf(arr(NUM), obj({ a: INT, b: STR }, [])));
    expect(inferSchema([[1], ['a']])).toEqual(arr(anyOf(INT, STR)));
  });

  it('GM-6: objects with differing keys give optional properties; required = keys present in EVERY sample', () => {
    expect(inferSchema([{ a: 1 }, { a: 2 }])).toEqual(obj({ a: INT }, ['a']));
    expect(inferSchema([{ a: 1, b: 'x' }, { a: 2 }])).toEqual(obj({ a: INT, b: STR }, ['a']));
    expect(inferSchema([{ a: 1 }, { b: 'x' }])).toEqual(obj({ a: INT, b: STR }, []));
    expect(inferSchema([{}, { a: 1 }])).toEqual(obj({ a: INT }, []));
    expect(inferSchema([{ a: 1 }, {}])).toEqual(obj({ a: INT }, []));
    expect(inferSchema([{}])).toEqual(obj({}, []));
    expect(inferSchema([{}, {}])).toEqual(obj({}, []));
    expect(inferSchema([{ a: 1 }])).toEqual(obj({ a: INT }, ['a']));
    // present in two of three samples is still optional
    expect(inferSchema([{ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1 }])).toEqual(obj({ a: INT, b: INT }, ['a']));
    expect(inferSchema([{ a: 1, b: 1 }, { a: 1 }, { a: 1, b: 1 }])).toEqual(obj({ a: INT, b: INT }, ['a']));
    // an explicit null value counts as present
    expect(inferSchema([{ a: null }, { a: null }])).toEqual(obj({ a: NUL }, ['a']));
  });

  it('GM-6: required is sorted and independent of key insertion order', () => {
    expect(requiredOf(inferSchema([{ b: 1, a: 1, c: 1 }]))).toEqual(['a', 'b', 'c']);
    expect(requiredOf(inferSchema([{ c: 1, b: 1 }, { b: 2, a: 0, c: 3 }]))).toEqual(['b', 'c']);
  });

  it('GM-6: property schemas merge only the samples that have the key', () => {
    expect(inferSchema([{ a: 1 }, { a: 2.5 }])).toEqual(obj({ a: NUM }, ['a']));
    expect(inferSchema([{ a: 1 }, { a: 'x' }])).toEqual(obj({ a: anyOf(INT, STR) }, ['a']));
    expect(inferSchema([{ a: 1 }, { b: 'x' }, { a: 2 }])).toEqual(obj({ a: INT, b: STR }, []));
  });

  it('GM-6: nested objects merge recursively, required-ness computed over the samples where the parent exists', () => {
    expect(inferSchema([{ o: { x: 1 } }, { o: { x: 2, y: 's' } }])).toEqual(obj({ o: obj({ x: INT, y: STR }, ['x']) }, ['o']));
    expect(inferSchema([{ o: { x: 1 } }, {}])).toEqual(obj({ o: obj({ x: INT }, ['x']) }, []));
    expect(inferSchema([{ o: { x: 1 } }, { o: {} }])).toEqual(obj({ o: obj({ x: INT }, []) }, ['o']));
    expect(inferSchema([{ o: { p: { q: 1 } } }, { o: { p: { q: 2.5 } } }])).toEqual(obj({ o: obj({ p: obj({ q: NUM }, ['q']) }, ['p']) }, ['o']));
  });

  it('GM-6: arrays merge item schemas', () => {
    expect(inferSchema([[1, 2], [3]])).toEqual(arr(INT));
    expect(inferSchema([[1], [2.5]])).toEqual(arr(NUM));
    expect(inferSchema([[1, 'a']])).toEqual(arr(anyOf(INT, STR)));
    expect(inferSchema([['a'], [1]])).toEqual(arr(anyOf(INT, STR)));
    expect(inferSchema([[[1]], [[2.5]]])).toEqual(arr(arr(NUM)));
    expect(inferSchema([[null], [1]])).toEqual(arr(anyOf(NUL, INT)));
    // items are pooled across arrays, so a key missing from one element makes it optional
    expect(inferSchema([[{ a: 1 }], [{ a: 2 }, { b: 1 }]])).toEqual(arr(obj({ a: INT, b: INT }, [])));
    expect(inferSchema([[{ a: 1 }, { a: 2 }]])).toEqual(arr(obj({ a: INT }, ['a'])));
  });

  it('GM-6: empty arrays contribute no item information; with no items at all the item schema is the any-schema', () => {
    expect(inferSchema([[]])).toEqual(arr(ANY));
    expect(inferSchema([[], []])).toEqual(arr(ANY));
    expect(inferSchema([[], [1]])).toEqual(arr(INT));
    expect(inferSchema([[1], []])).toEqual(arr(INT));
    expect(inferSchema([{ a: [] }])).toEqual(obj({ a: arr(ANY) }, ['a']));
    expect(inferSchema([{ a: [] }, { a: [1] }])).toEqual(obj({ a: arr(INT) }, ['a']));
    expect(inferSchema([[[]], [[2]]])).toEqual(arr(arr(INT)));
    const empty = inferSchema([[]]);
    expect(isArraySchema(empty) ? Object.keys(empty.items) : ['not an array']).toEqual([]);
  });

  it('GM-6: never emits enum or additionalProperties, even for repeated constants and nested objects', () => {
    const s = inferSchema([{ k: 'same', n: { m: 1 }, l: ['x'] }, { k: 'same', n: { m: 1 }, l: ['x'] }]);
    expect(s).toEqual(obj({ k: STR, n: obj({ m: INT }, ['m']), l: arr(STR) }, ['k', 'l', 'n']));
    expect(inferredViolations(s)).toEqual([]);
    expect(isEnumSchema(inferSchema(['a', 'a']))).toBe(false);
    expect(isEnumSchema(inferSchema([true]))).toBe(false);
    expect(isEnumSchema(inferSchema([null]))).toBe(false);
  });

  it('GM-6: is order-independent for the set of samples and indifferent to duplicates', () => {
    const rng = mulberry32(99);
    const sets: JsonValue[][] = [
      ['x', 1.5, true, null, [1], { a: 1 }],
      [{ a: 1, b: 'x' }, { a: 2.5 }, { c: [1, 2] }, { a: null }],
      [[1], ['a', [2]], [], [[]]],
      [{ o: { x: 1 } }, { o: 'str' }, { o: [1] }, {}],
    ];
    for (const samples of sets) {
      const expected = inferSchema(samples);
      expect(inferSchema([...samples].reverse())).toEqual(expected);
      for (let i = 0; i < 6; i++) expect(inferSchema(shuffled(rng, samples))).toEqual(expected);
      expect(inferSchema([...samples, ...samples])).toEqual(expected);
      expect(inferSchema([...samples, samples[0] ?? null])).toEqual(expected);
    }
  });

  it('T11: own keys named like Object.prototype members are ordinary keys (__proto__ included)', () => {
    const s = inferSchema([JSON.parse('{"__proto__":1,"constructor":"x","a":true}') as JsonValue]);
    expect(Object.keys(propsOf(s)).sort()).toEqual(['__proto__', 'a', 'constructor']);
    expect(hasOwn(propsOf(s), '__proto__')).toBe(true);
    expect(requiredOf(s)).toEqual(['__proto__', 'a', 'constructor']);

    const merged = inferSchema([JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue, JSON.parse('{"__proto__":{"other":1}}') as JsonValue]);
    expect(hasOwn(propsOf(merged), '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { other?: number }).other).toBeUndefined();
    expect(Object.keys(propsOf(propsOf(merged)['__proto__'] ?? ANY)).sort()).toEqual(['other', 'polluted']);
  });

  it('GM-6: the inferred schema accepts every sample (seeded property test, 3 seeds x 150 sample sets)', () => {
    const failures: string[] = [];
    for (const seed of [11, 2024, 77_777]) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 150; i++) {
        const samples = genSamples(rng);
        const schema = inferSchema(samples);
        for (const sample of samples) if (!conformsTo(sample, schema)) failures.push(`seed ${seed}: ${json(sample)} !~ ${json(schema)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('GM-6: inferred schemas are canonical (sorted required, ordered flat anyOf, no enum, no additionalProperties) and order-independent (property test)', () => {
    const rng = mulberry32(31337);
    const failures: string[] = [];
    for (let i = 0; i < 300; i++) {
      const samples = genSamples(rng);
      const schema = inferSchema(samples);
      failures.push(...inferredViolations(schema).map((v) => `${v} in ${json(schema)}`));
      expect(inferSchema(shuffled(rng, samples)), `order dependent: ${json(samples)}`).toEqual(schema);
    }
    expect(failures).toEqual([]);
  });

  it('GM-6: merging is compositional: object properties and array items equal the inference of the pooled values (property test)', () => {
    const rng = mulberry32(4242);
    let objectSets = 0;
    let arraySets = 0;
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rng() * 5);
      if (i % 2 === 0) {
        const samples = Array.from({ length: n }, () => genObjectValue(rng, 3));
        const schema = inferSchema(samples);
        const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))].sort();
        expect(Object.keys(propsOf(schema)).sort()).toEqual(keys);
        expect(requiredOf(schema)).toEqual(keys.filter((k) => samples.every((s) => hasOwn(s, k))));
        for (const key of keys) {
          const pooled = samples.filter((s) => hasOwn(s, key)).map((s) => s[key] ?? null);
          expect(propsOf(schema)[key], `property ${key} of ${json(samples)}`).toEqual(inferSchema(pooled));
        }
        objectSets++;
      } else {
        const samples = Array.from({ length: n }, () => genArrayValue(rng, 3));
        const pooled = samples.flat();
        expect(inferSchema(samples), json(samples)).toEqual(arr(pooled.length === 0 ? ANY : inferSchema(pooled)));
        arraySets++;
      }
    }
    expect(objectSets).toBe(150);
    expect(arraySets).toBe(150);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// conformsTo
// ---------------------------------------------------------------------------------------------------------------------

const VALUES: JsonValue[] = [null, true, false, 0, 1, -3, 1.5, '', 'a', [], {}, [1], { a: 1 }];
const accepted = (s: Schema): JsonValue[] => VALUES.filter((v) => conformsTo(v, s));

describe('T11: conformsTo', () => {
  it('T11: primitive schemas accept exactly their kind', () => {
    expect(accepted(NUL)).toEqual([null]);
    expect(accepted(BOOL)).toEqual([true, false]);
    expect(accepted(INT)).toEqual([0, 1, -3]);
    expect(accepted(NUM)).toEqual([0, 1, -3, 1.5]);
    expect(accepted(STR)).toEqual(['', 'a']);
  });

  it('T11: the any-schema accepts every JsonValue', () => {
    expect(accepted(ANY)).toEqual(VALUES);
    expect(conformsTo({ a: [1, { b: null }] }, ANY)).toBe(true);
  });

  it('T11: integer accepts only integral numbers (1.0 is integral), number accepts any finite number', () => {
    expect(conformsTo(1.0, INT)).toBe(true);
    expect(conformsTo(2 / 2, INT)).toBe(true);
    expect(conformsTo(1.5, INT)).toBe(false);
    expect(conformsTo(-0.5, INT)).toBe(false);
    expect(conformsTo(1.5, NUM)).toBe(true);
    expect(conformsTo(1, NUM)).toBe(true);
    expect(conformsTo(1e300, NUM)).toBe(true);
    expect(conformsTo(1e21, INT)).toBe(true);
    expect(conformsTo('1', INT)).toBe(false);
    expect(conformsTo('1', NUM)).toBe(false);
    expect(conformsTo(true, NUM)).toBe(false);
    expect(conformsTo(null, INT)).toBe(false);
  });

  it('T11: NaN and the infinities are not JsonValues: they fail number and integer, also nested', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(conformsTo(bad, NUM)).toBe(false);
      expect(conformsTo(bad, INT)).toBe(false);
      expect(conformsTo(bad, anyOf(INT, NUM))).toBe(false);
      expect(conformsTo([1, bad], arr(NUM))).toBe(false);
      expect(conformsTo({ a: bad }, obj({ a: NUM }, ['a']))).toBe(false);
      expect(conformsTo({ a: bad }, obj({ a: INT }))).toBe(false);
      expect(conformsTo(bad, en(1, 2))).toBe(false);
    }
  });

  it('T11: arrays check every item, and only arrays are arrays', () => {
    expect(conformanceMisses([
      [[], arr(INT), true],
      [[1, 2, 3], arr(INT), true],
      [[1, 2, 'x'], arr(INT), false],
      [['x', 2, 3], arr(INT), false],
      [[1, 'x', 3], arr(INT), false],
      [[1, 2.5], arr(INT), false],
      [[1, 2.5], arr(NUM), true],
      [[[1], [2, 3]], arr(arr(INT)), true],
      [[[1], [2, 'x']], arr(arr(INT)), false],
      [[1, 'a', null], arr(ANY), true],
      [{}, arr(ANY), false],
      [{ 0: 1 }, arr(ANY), false],
      ['a', arr(ANY), false],
      [null, arr(ANY), false],
      [1, arr(ANY), false],
      [[], obj({}), false],
      [[1], obj({}), false],
      [[], obj({}, [], true), false],
      [[], STR, false],
    ])).toEqual([]);
  });

  it('T11: objects require every required key, check every defined property, and only objects are objects', () => {
    expect(conformanceMisses([
      [{ a: 1 }, obj({ a: INT }, ['a']), true],
      [{}, obj({ a: INT }, ['a']), false],
      [{ b: 1 }, obj({ a: INT }, ['a']), false],
      [{}, obj({ a: INT }), true],
      [{ a: 1 }, obj({ a: INT }), true],
      [{ a: 'x' }, obj({ a: INT }), false],
      [{ a: 'x' }, obj({ a: INT }, ['a']), false],
      [{ a: 1, b: 'x' }, obj({ a: INT, b: INT }), false],
      [{ a: 'x', b: 1 }, obj({ a: INT, b: INT }), false],
      [{ a: 1, b: 2 }, obj({ a: INT, b: INT }, ['a', 'b']), true],
      [{ a: 1 }, obj({ a: INT, b: INT }, ['a', 'b']), false],
      [{ b: 1 }, obj({ a: INT, b: INT }, ['a', 'b']), false],
      [{ a: null }, obj({ a: NUL }, ['a']), true],
      [{ a: null }, obj({ a: INT }, ['a']), false],
      [{}, obj({}), true],
      [{ a: { x: 1 } }, obj({ a: obj({ x: INT }, ['x']) }, ['a']), true],
      [{ a: {} }, obj({ a: obj({ x: INT }, ['x']) }, ['a']), false],
      [{ a: { x: 'y' } }, obj({ a: obj({ x: INT }, ['x']) }, ['a']), false],
      [{ a: [1, 2] }, obj({ a: arr(INT) }, ['a']), true],
      [{ a: [1, 'z'] }, obj({ a: arr(INT) }, ['a']), false],
      // a required key the schema does not define is required but unconstrained
      [{ x: null }, obj({}, ['x']), true],
      [{ x: { deep: [1] } }, obj({}, ['x']), true],
      [{}, obj({}, ['x']), false],
      // not objects
      [[], obj({}), false],
      [null, obj({}), false],
      ['a', obj({}), false],
      [1, obj({}), false],
      [true, obj({}), false],
    ])).toEqual([]);
  });

  it('T11: extra properties are allowed unless additionalProperties is false', () => {
    expect(conformanceMisses([
      [{ a: 1, z: 'anything' }, obj({ a: INT }), true],
      [{ a: 1, z: { n: [null] } }, obj({ a: INT }, ['a']), true],
      [{ z: 1 }, obj({}), true],
      [{ a: 1, z: 1 }, obj({ a: INT }, [], true), true],
      [{ a: 1, z: 1 }, obj({ a: INT }, [], false), false],
      [{ z: 1 }, obj({}, [], false), false],
      [{ a: 1 }, obj({ a: INT }, [], false), true],
      [{}, obj({ a: INT }, [], false), true],
      [{}, obj({}, [], false), true],
      [{ a: 1, b: 2 }, obj({ a: INT, b: INT }, ['a'], false), true],
      [{ a: 1, b: 2, c: 3 }, obj({ a: INT, b: INT }, ['a'], false), false],
      [{ a: 'x' }, obj({ a: INT }, [], false), false],
    ])).toEqual([]);
  });

  it('T11: keys are matched as OWN properties, never through Object.prototype', () => {
    expect(conformsTo({}, obj({}, ['constructor']))).toBe(false);
    expect(conformsTo({}, obj({}, ['toString']))).toBe(false);
    expect(conformsTo({}, obj({}, ['__proto__']))).toBe(false);
    expect(conformsTo({ constructor: 1 }, obj({}, ['constructor']))).toBe(true);
    expect(conformsTo(JSON.parse('{"__proto__":1}') as JsonValue, obj({}, ['__proto__']))).toBe(true);
    // a value key that shadows a prototype member is just an extra property
    expect(conformsTo({ constructor: 'x' }, obj({}))).toBe(true);
    expect(conformsTo({ toString: 1 }, obj({ a: INT }))).toBe(true);
    expect(conformsTo({ toString: 1 }, obj({}, [], false))).toBe(false);
    expect(conformsTo({ constructor: 1 }, obj({}, [], false))).toBe(false);
    expect(conformsTo({ constructor: 1 }, obj({ constructor: INT }, [], false))).toBe(true);
    expect(conformsTo({ constructor: 'x' }, obj({ constructor: INT }))).toBe(false);
    expect(conformsTo({}, obj({ constructor: INT }))).toBe(true);
  });

  it('T11: enum uses deep JSON equality', () => {
    expect(conformanceMisses([
      [1, en(1, 2), true],
      [2, en(1, 2), true],
      [3, en(1, 2), false],
      ['1', en(1), false],
      [1, en('1'), false],
      [1.0, en(1), true],
      [1.5, en(1.5), true],
      [1.5, en(1), false],
      ['a', en('a'), true],
      ['A', en('a'), false],
      [null, en(null), true],
      [0, en(null), false],
      [false, en(null), false],
      [null, en(0, false, ''), false],
      [false, en(0), false],
      [0, en(false), false],
      ['', en(0), false],
      [true, en(true), true],
      [[1, 2], en([1, 2]), true],
      [[2, 1], en([1, 2]), false],
      [[1], en([1, 2]), false],
      [[1, 2, 3], en([1, 2]), false],
      [[], en([]), true],
      [[], en({}), false],
      [{}, en([]), false],
      [{}, en({}), true],
      [{ a: 1, b: [1] }, en({ b: [1], a: 1 }), true],
      [{ a: 1 }, en({ a: 1, b: [1] }), false],
      [{ a: 1, b: [1], c: 2 }, en({ a: 1, b: [1] }), false],
      [{ a: 1, b: [2] }, en({ a: 1, b: [1] }), false],
      [{ b: 1 }, en({ a: 1 }), false],
      [{ a: { x: [1, { y: null }] } }, en({ a: { x: [1, { y: null }] } }), true],
      [{ a: { x: [1, { y: 0 }] } }, en({ a: { x: [1, { y: null }] } }), false],
      [{ 0: 'a' }, en(['a']), false],
      [['a'], en({ 0: 'a' }), false],
      [1, en('x', 1, null), true],
      [1, en(), false],
      [null, en(), false],
    ])).toEqual([]);
  });

  it('T11: anyOf accepts when some member accepts; an empty anyOf accepts nothing', () => {
    expect(conformanceMisses([
      [1, anyOf(INT, STR), true],
      ['a', anyOf(INT, STR), true],
      [null, anyOf(INT, STR), false],
      [1.5, anyOf(INT, STR), false],
      [1.5, anyOf(INT, NUM), true],
      [null, anyOf(INT, NUL), true],
      [[1], anyOf(STR, arr(INT)), true],
      [['x'], anyOf(STR, arr(INT)), false],
      [{ a: 1 }, anyOf(arr(INT), obj({ a: INT }, ['a'])), true],
      [{ a: 'x' }, anyOf(arr(INT), obj({ a: INT }, ['a'])), false],
      [1, anyOf(anyOf(STR), anyOf(NUL, INT)), true],
      [true, anyOf(anyOf(STR), anyOf(NUL, INT)), false],
      [3, anyOf(en(1, 2), en(3)), true],
      [4, anyOf(en(1, 2), en(3)), false],
      [{ x: 1 }, anyOf(STR, ANY), true],
      [1, anyOf(), false],
      [null, anyOf(), false],
      [{}, anyOf(), false],
    ])).toEqual([]);
  });

  it('T11: values generated from a schema conform to it (seeded corpus)', () => {
    const rng = mulberry32(8080);
    const failures: string[] = [];
    for (const schema of buildCorpus()) {
      for (let i = 0; i < 8; i++) {
        const value = genFor(schema, rng);
        if (value !== undefined && !conformsTo(value, schema)) failures.push(`${json(value)} !~ ${json(schema)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('T11: values missing a required key or carrying an extra key under a closed schema are rejected (seeded corpus)', () => {
    const rng = mulberry32(6060);
    const failures: string[] = [];
    for (const schema of buildCorpus()) {
      if (!isObjectSchema(schema)) continue;
      const required = schema.required ?? [];
      for (let i = 0; i < 6; i++) {
        const value = genFor(schema, rng);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue; // includes undefined: accepts nothing
        for (const key of required) {
          const without = { ...value };
          delete without[key];
          if (conformsTo(without, schema)) failures.push(`missing required ${key}: ${json(without)} ~ ${json(schema)}`);
        }
        if (schema.additionalProperties === false && conformsTo({ ...value, zzz: 1 }, schema)) failures.push(`extra key accepted by ${json(schema)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// GM-7: isAssignable
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-7: isAssignable', () => {
  it('GM-7: the corpus covers every schema kind, nested', () => {
    const corpus = buildCorpus();
    const kinds = new Set<string>();
    let maxDepth = 0;
    for (const s of corpus) {
      const stack: Array<readonly [Schema, number]> = [[s, 1]];
      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        const [node, depth] = top;
        maxDepth = Math.max(maxDepth, depth);
        const kind = isAnyOfSchema(node) ? 'anyOf' : isEnumSchema(node) ? 'enum' : 'type' in node ? String(node.type) : 'any';
        kinds.add(kind);
        if (isArraySchema(node)) stack.push([node.items, depth + 1]);
        else if (isObjectSchema(node)) for (const p of Object.values(node.properties)) stack.push([p, depth + 1]);
        else if (isAnyOfSchema(node)) for (const m of node.anyOf) stack.push([m, depth + 1]);
      }
    }
    expect([...kinds].sort()).toEqual(['any', 'anyOf', 'array', 'boolean', 'enum', 'integer', 'null', 'number', 'object', 'string']);
    expect(maxDepth).toBeGreaterThanOrEqual(3);
    expect(corpus.length).toBeGreaterThanOrEqual(70);
  });

  it('GM-7: isAssignable is reflexive over a corpus of schemas of every kind, nested', () => {
    const corpus = buildCorpus();
    const failures = corpus.filter((s) => !isAssignable(s, JSON.parse(json(s)) as Schema)).map(json);
    expect(failures).toEqual([]);
  });

  it('GM-7: integer is assignable to number and not the reverse', () => {
    expect(isAssignable(INT, NUM)).toBe(true);
    expect(isAssignable(NUM, INT)).toBe(false);
  });

  it('GM-7: primitives are assignable only to themselves (and integer to number)', () => {
    const misses: string[] = [];
    for (const from of PRIMITIVES) {
      for (const to of PRIMITIVES) {
        const expected = json(from) === json(to) || (json(from) === json(INT) && json(to) === json(NUM));
        if (isAssignable(from, to) !== expected) misses.push(`${json(from)} -> ${json(to)}: expected ${String(expected)}`);
      }
    }
    expect(misses).toEqual([]);
    const containers = [arr(ANY), obj({}), obj({}, [], true)];
    for (const p of PRIMITIVES) {
      for (const c of containers) {
        expect(isAssignable(p, c), `${json(p)} -> ${json(c)}`).toBe(false);
        expect(isAssignable(c, p), `${json(c)} -> ${json(p)}`).toBe(false);
      }
      expect(isAssignable(p, en(1)), `${json(p)} -> enum`).toBe(false);
    }
  });

  it('GM-7: the any-schema as target accepts every schema, as source it is assignable only to the any-schema', () => {
    const corpus = buildCorpus();
    for (const s of corpus) expect(isAssignable(s, ANY), json(s)).toBe(true);
    expect(isAssignable(ANY, ANY)).toBe(true);
    expect(isAssignable(en(), ANY)).toBe(true);
    expect(isAssignable(anyOf(), ANY)).toBe(true);
    for (const s of corpus) {
      if (Object.keys(s).length === 0) continue;
      if (isAnyOfSchema(s) && s.anyOf.some((m) => Object.keys(m).length === 0)) continue; // semantically any: left unpinned
      expect(isAssignable(ANY, s), `any -> ${json(s)}`).toBe(false);
    }
    expect(assignabilityMisses([
      [ANY, STR, false],
      [ANY, NUM, false],
      [ANY, arr(ANY), false],
      [ANY, obj({}), false],
      [ANY, obj({}, [], true), false],
      [ANY, en(1), false],
      [ANY, anyOf(STR, INT), false],
      [ANY, anyOf(STR, NUL, INT, BOOL, arr(ANY), obj({})), false],
    ])).toEqual([]);
  });

  it('GM-7: enum as source: every member must conform to the target', () => {
    expect(assignabilityMisses([
      [en('a', 'b'), STR, true],
      [en('a', 1), STR, false],
      [en(1), STR, false],
      [en(1, 2), INT, true],
      [en(1, 2.5), INT, false],
      [en(1, 2.5), NUM, true],
      [en(1.5), INT, false],
      [en(null), NUL, true],
      [en(null, 1), NUL, false],
      [en(true, false), BOOL, true],
      [en(true, 0), BOOL, false],
      [en(true), STR, false],
      [en('a', 'b'), ANY, true],
      [en([1]), arr(INT), true],
      [en([1, 'a']), arr(INT), false],
      [en({ a: 1 }), obj({ a: INT }, ['a']), true],
      [en({}), obj({ a: INT }, ['a']), false],
      [en({ a: 1, b: 'x' }), obj({ a: INT }, ['a'], false), false],
      [en({ a: 1, b: 'x' }), obj({ a: INT }, ['a']), true],
      [en('a', 1), anyOf(STR, INT), true],
      [en('a', null), anyOf(STR, INT), false],
      [en(1), anyOf(arr(INT), STR), false],
      // enum to enum: subset rules
      [en('a'), en('a', 'b'), true],
      [en('a', 'b'), en('a'), false],
      [en('a', 'b'), en('b', 'a'), true],
      [en('a'), en('b'), false],
      [en('a', 'b'), en('b', 'c'), false],
      [en(1), en(1.0), true],
      [en(1), en('1'), false],
      [en(null), en(0), false],
      [en({ a: 1, b: 2 }), en({ b: 2, a: 1 }), true],
      [en({ a: 1 }), en({ a: 1, b: 2 }), false],
      [en([1, 2]), en([2, 1]), false],
      [en([1, 2]), en([1, 2], 'z'), true],
      // member-wise against an anyOf target is exact for enums
      [en('a'), anyOf(en('a'), en('b')), true],
      [en('a', 'b'), anyOf(en('a'), en('b')), true],
      [en('a', 'c'), anyOf(en('a'), en('b')), false],
    ])).toEqual([]);
  });

  it('GM-7: enum as target: the source must be an enum subset or a single-value schema', () => {
    expect(assignabilityMisses([
      [NUL, en(null), true],
      [NUL, en(null, 1), true],
      [NUL, en(1), false],
      [NUL, en('a'), false],
      [NUL, en(), false],
      [STR, en('a'), false],
      [STR, en('a', 'b'), false],
      [INT, en(1), false],
      [INT, en(1, 2, 3), false],
      [NUM, en(1, 2), false],
      [BOOL, en(true), false],
      [arr(INT), en([1]), false],
      [arr(INT), en([]), false],
      [obj({}), en({}), false],
      [obj({ a: INT }, ['a']), en({ a: 1 }), false],
      [ANY, en(1), false],
      [anyOf(en('a'), en('b')), en('a', 'b', 'c'), true],
      [anyOf(en('a'), en('b')), en('a'), false],
      [anyOf(en('a'), STR), en('a', 'b'), false],
      [anyOf(NUL), en(null), true],
      [en('a'), en('a'), true],
    ])).toEqual([]);
  });

  it('GM-7: arrays are covariant in their items and only assignable to arrays', () => {
    expect(assignabilityMisses([
      [arr(INT), arr(NUM), true],
      [arr(NUM), arr(INT), false],
      [arr(INT), arr(INT), true],
      [arr(STR), arr(INT), false],
      [arr(ANY), arr(ANY), true],
      [arr(INT), arr(ANY), true],
      [arr(ANY), arr(INT), false],
      [arr(arr(INT)), arr(arr(NUM)), true],
      [arr(arr(NUM)), arr(arr(INT)), false],
      [arr(arr(INT)), arr(INT), false],
      [arr(INT), arr(arr(INT)), false],
      [arr(en(1)), arr(INT), true],
      [arr(INT), arr(en(1)), false],
      [arr(anyOf(INT, STR)), arr(anyOf(NUM, STR, NUL)), true],
      [arr(anyOf(INT, STR)), arr(STR), false],
      [arr(STR), arr(anyOf(INT, STR)), true],
      [arr(obj({ a: INT }, ['a'])), arr(obj({ a: NUM }, ['a'])), true],
      [arr(obj({ a: NUM }, ['a'])), arr(obj({ a: INT }, ['a'])), false],
      [arr(INT), ANY, true],
      [arr(INT), INT, false],
      [INT, arr(INT), false],
      [arr(INT), NUL, false],
      [arr(INT), obj({}), false],
      [obj({}), arr(ANY), false],
      [arr(INT), anyOf(arr(NUM), STR), true],
      [arr(INT), anyOf(arr(STR), STR), false],
    ])).toEqual([]);
  });

  it('GM-7: objects: every key the target requires must be required in the source', () => {
    expect(assignabilityMisses([
      [obj({ a: INT }, ['a']), obj({ a: INT }, ['a']), true],
      [obj({ a: INT }, ['a']), obj({ a: INT }), true],
      [obj({ a: INT }, ['a']), obj({ a: INT }, []), true],
      [obj({ a: INT }), obj({ a: INT }, ['a']), false],
      [obj({ a: INT }, []), obj({ a: INT }, ['a']), false],
      [obj({ a: INT, b: INT }, ['a', 'b']), obj({ a: INT, b: INT }, ['a']), true],
      [obj({ a: INT, b: INT }, ['a']), obj({ a: INT, b: INT }, ['a', 'b']), false],
      [obj({ a: INT, b: INT }, ['b', 'a']), obj({ a: INT, b: INT }, ['a', 'b']), true],
      [obj({ a: INT, b: INT }, ['b']), obj({ a: INT, b: INT }, ['a', 'b']), false],
      // required but undefined in the target: unconstrained, still must be required in the source
      [obj({ a: INT }, ['a']), obj({}, ['a']), true],
      [obj({}, ['a']), obj({}, ['a']), true],
      [obj({}, []), obj({}, ['a']), false],
      [obj({ a: INT }), obj({}, ['a']), false],
      [obj({ a: INT }, ['a']), obj({}, ['a', 'b']), false],
      [obj({ a: INT, b: STR }, ['a', 'b']), obj({}, ['b']), true],
    ])).toEqual([]);
  });

  it('GM-7: objects: every property both sides define must be assignable', () => {
    expect(assignabilityMisses([
      [obj({ a: INT }), obj({ a: NUM }), true],
      [obj({ a: NUM }), obj({ a: INT }), false],
      [obj({ a: INT }, ['a']), obj({ a: NUM }, ['a']), true],
      [obj({ a: NUM }, ['a']), obj({ a: INT }, ['a']), false],
      [obj({ a: STR }), obj({ a: INT }), false],
      [obj({ a: INT, b: STR }), obj({ a: INT, b: INT }), false],
      [obj({ a: INT, b: STR }), obj({ a: NUM, b: STR }), true],
      [obj({ a: STR, b: INT }), obj({ a: INT, b: INT }), false],
      [obj({ a: ANY }), obj({ a: INT }), false],
      [obj({ a: INT }), obj({ a: ANY }), true],
      [obj({ a: arr(INT) }), obj({ a: arr(NUM) }), true],
      [obj({ a: arr(NUM) }), obj({ a: arr(INT) }), false],
      [obj({ o: obj({ x: INT }, ['x']) }, ['o']), obj({ o: obj({ x: NUM }, ['x']) }, ['o']), true],
      [obj({ o: obj({ x: NUM }, ['x']) }, ['o']), obj({ o: obj({ x: INT }, ['x']) }, ['o']), false],
      [obj({ o: obj({ x: INT }) }, ['o']), obj({ o: obj({ x: INT }, ['x']) }, ['o']), false],
      [obj({ o: obj({ x: INT }, ['x']) }, ['o']), obj({ o: obj({ x: INT }) }, ['o']), true],
      [obj({ a: INT }, ['a']), obj({ a: anyOf(INT, NUL) }, ['a']), true],
      [obj({ a: anyOf(INT, NUL) }, ['a']), obj({ a: INT }, ['a']), false],
      // an optional property in the source may be required in the target only if required in the source (see above)
      [obj({ a: INT }, ['a']), obj({ a: NUM }), true],
      // objects are only assignable to objects, any, or an anyOf with a compatible member
      [obj({ a: INT }), STR, false],
      [obj({ a: INT }), NUL, false],
      [obj({ a: INT }), arr(INT), false],
      [obj({ a: INT }), ANY, true],
      [obj({}), anyOf(NUL, obj({})), true],
      [obj({ a: INT }, ['a']), anyOf(STR, obj({ a: NUM }, ['a'])), true],
      [obj({ a: INT }, ['a']), anyOf(STR, obj({ a: STR }, ['a'])), false],
    ])).toEqual([]);
  });

  it('GM-7: object width: extra source properties are fine unless the target is closed', () => {
    expect(assignabilityMisses([
      [obj({ a: INT, b: STR }), obj({ a: INT }), true],
      [obj({ a: INT, b: STR }, ['a', 'b']), obj({ a: INT }, ['a']), true],
      [obj({ a: INT }), obj({}), true],
      [obj({ a: INT }, ['a']), obj({}), true],
      [obj({ a: INT }), obj({ a: INT }, [], true), true],
      [obj({ a: INT, b: STR }), obj({ a: INT }, [], true), true],
      [obj({ a: INT }, [], true), obj({ a: INT }), true],
      [obj({ a: INT }), obj({ a: INT }), true],
    ])).toEqual([]);
  });

  it('GM-7: object width: a property the target defines and the source omits needs a closed source and an optional target property', () => {
    expect(assignabilityMisses([
      // open source might carry an incompatible value under the omitted key: conservative false
      [obj({}), obj({ a: INT }), false],
      [obj({ a: INT }), obj({ a: INT, b: INT }), false],
      [obj({}, [], true), obj({ a: INT }), false],
      [obj({ a: INT }, [], true), obj({ a: INT, b: INT }), false],
      // closed source cannot carry the key at all
      [obj({}, [], false), obj({ a: INT }), true],
      [obj({ a: INT }, [], false), obj({ a: INT, b: INT }), true],
      [obj({ a: INT }, ['a'], false), obj({ a: INT, b: INT }, ['a']), true],
      [obj({}, [], false), obj({ a: ANY }), true],
      // but not if the target requires it
      [obj({}, [], false), obj({ a: INT }, ['a']), false],
      [obj({ a: INT }, [], false), obj({ a: INT, b: INT }, ['b']), false],
      [obj({ a: INT }, ['a'], false), obj({ a: INT, b: INT }, ['a', 'b']), false],
      [obj({}), obj({ a: INT }, ['a']), false],
    ])).toEqual([]);
  });

  it('GM-7: object width: a closed target needs a closed source with no extra properties', () => {
    expect(assignabilityMisses([
      [obj({ a: INT }, [], false), obj({ a: INT }, [], false), true],
      [obj({ a: INT }), obj({ a: INT }, [], false), false],
      [obj({ a: INT }, [], true), obj({ a: INT }, [], false), false],
      [obj({ a: INT, b: STR }, [], false), obj({ a: INT }, [], false), false],
      [obj({ a: INT }, [], false), obj({ a: INT, b: STR }, [], false), true],
      [obj({ a: INT }, [], false), obj({ a: INT }), true],
      [obj({ a: INT }, [], false), obj({ a: INT }, [], true), true],
      [obj({}, [], false), obj({}, [], false), true],
      [obj({}, [], false), obj({}), true],
      [obj({}), obj({}, [], false), false],
      [obj({ a: INT }, ['a'], false), obj({ a: NUM }, ['a'], false), true],
      [obj({ a: NUM }, ['a'], false), obj({ a: INT }, ['a'], false), false],
      [obj({ a: INT }, ['a'], false), obj({ a: INT, b: INT }, ['a'], false), true],
      [obj({ a: INT, b: INT }, ['a', 'b'], false), obj({ a: INT }, ['a'], false), false],
      [obj({ a: INT, b: INT }, ['a', 'b'], false), obj({ a: INT }, ['a']), true],
    ])).toEqual([]);
  });

  it('GM-7: object keys that collide with Object.prototype members are matched as own keys only', () => {
    expect(assignabilityMisses([
      [obj({}, [], false), obj({ constructor: INT }), true],
      [obj({}), obj({ constructor: INT }), false],
      [obj({}), obj({ toString: INT }), false],
      [obj({ constructor: INT }), obj({ constructor: NUM }), true],
      [obj({ constructor: NUM }), obj({ constructor: INT }), false],
      [obj({ constructor: INT }, [], false), obj({}, [], false), false],
      [obj({ a: INT }), obj({}, ['constructor']), false],
      [obj({}, ['constructor']), obj({}, ['constructor']), true],
      [obj({}, ['a']), obj({}, ['toString']), false],
    ])).toEqual([]);
  });

  it('GM-7: anyOf as source: every member must be assignable to the target', () => {
    expect(assignabilityMisses([
      [anyOf(INT, STR), anyOf(INT, STR), true],
      [anyOf(INT, STR), anyOf(STR, INT), true],
      [anyOf(INT, STR), STR, false],
      [anyOf(INT, STR), INT, false],
      [anyOf(INT, STR), ANY, true],
      [anyOf(INT, STR), NUL, false],
      [anyOf(STR), STR, true],
      [anyOf(INT, INT), INT, true],
      [anyOf(INT, NUM), NUM, true],
      [anyOf(INT, NUM), INT, false],
      [anyOf(INT, STR), anyOf(NUM, STR, NUL), true],
      [anyOf(INT, STR, BOOL), anyOf(NUM, STR), false],
      [anyOf(INT, STR), anyOf(NUM), false],
      [anyOf(en('a'), en('b')), STR, true],
      [anyOf(en('a'), en('b')), en('a', 'b'), true],
      [anyOf(en('a'), en('b')), en('a'), false],
      [anyOf(en('a'), en(1)), STR, false],
      [anyOf(arr(INT), STR), anyOf(arr(NUM), STR), true],
      [anyOf(arr(INT), STR), anyOf(arr(NUM)), false],
      [anyOf(NUL, obj({ a: INT }, ['a'])), anyOf(NUL, obj({ a: NUM }, ['a'])), true],
      [anyOf(NUL, obj({ a: NUM }, ['a'])), anyOf(NUL, obj({ a: INT }, ['a'])), false],
      [anyOf(INT, ANY), INT, false],
      [anyOf(INT, ANY), ANY, true],
      [anyOf(anyOf(INT), anyOf(STR)), anyOf(INT, STR), true],
      [anyOf(anyOf(INT), anyOf(STR)), INT, false],
    ])).toEqual([]);
  });

  it('GM-7: anyOf as target: assignable when assignable to at least one member', () => {
    expect(assignabilityMisses([
      [INT, anyOf(INT, STR), true],
      [STR, anyOf(INT, STR), true],
      [NUL, anyOf(INT, STR), false],
      [INT, anyOf(NUM, STR), true],
      [NUM, anyOf(INT, STR), false],
      [NUM, anyOf(INT, NUM), true],
      [BOOL, anyOf(INT, STR, NUL), false],
      [arr(INT), anyOf(arr(NUM), STR), true],
      [en('a'), anyOf(STR, NUL), true],
      [ANY, anyOf(STR, INT), false],
      [obj({ a: INT }), anyOf(STR, obj({})), true],
      [obj({ a: INT }, ['a']), anyOf(STR, obj({ a: INT }, ['a'], false)), false],
      [obj({ a: INT }, ['a'], false), anyOf(STR, obj({ a: INT }, ['a'], false)), true],
      [INT, anyOf(anyOf(STR), anyOf(NUM)), true],
      [INT, anyOf(anyOf(STR), anyOf(NUL)), false],
      [anyOf(INT, STR), anyOf(anyOf(NUM), anyOf(STR)), true],
    ])).toEqual([]);
  });

  it('GM-7: anyOf false negative (documented): a source split across several target members is rejected, not guessed', () => {
    // These ARE semantically assignable (every boolean is either true or false), but the conservative rule only looks
    // for ONE target member that accepts the whole source, so the answer is false. This pins the incompleteness.
    const split = anyOf(en(true), en(false));
    expect(conformsTo(true, split) && conformsTo(false, split)).toBe(true);
    expect(isAssignable(BOOL, split)).toBe(false);

    const splitObjects = anyOf(obj({ a: en(true) }, ['a']), obj({ a: en(false) }, ['a']));
    const source = obj({ a: BOOL }, ['a']);
    expect(conformsTo({ a: true }, splitObjects) && conformsTo({ a: false }, splitObjects)).toBe(true);
    expect(isAssignable(source, splitObjects)).toBe(false);

    // the same split is accepted when the source is an enum: members are checked one by one, which is exact
    expect(isAssignable(en(true, false), split)).toBe(true);
    // and a source that fits a single member is accepted
    expect(isAssignable(BOOL, anyOf(en(true), BOOL))).toBe(true);
  });

  it('GM-7: empty enum and empty anyOf: no values, so vacuous as source and unreachable as target', () => {
    expect(assignabilityMisses([
      [en(), STR, true],
      [en(), en(), true],
      [en(), anyOf(), true],
      [en(), en('a'), true],
      [anyOf(), STR, true],
      [anyOf(), anyOf(), true],
      [anyOf(), en(), true],
      [anyOf(), ANY, true],
      [STR, anyOf(), false],
      [STR, en(), false],
      [ANY, anyOf(), false],
      [ANY, en(), false],
      [arr(INT), anyOf(), false],
      [obj({}), anyOf(), false],
      [NUL, anyOf(), false],
    ])).toEqual([]);
  });

  it('GM-7: schemas of unrelated kinds are never assignable (null, string, array, object)', () => {
    const open = obj({});
    const closed = obj({}, [], false);
    const kinds: Schema[] = [NUL, STR, arr(ANY), open];
    for (const from of kinds) {
      for (const to of kinds) expect(isAssignable(from, to), `${json(from)} -> ${json(to)}`).toBe(from === to);
    }
    expect(isAssignable(closed, open)).toBe(true);
    expect(isAssignable(open, closed)).toBe(false);
    for (const k of [NUL, STR, arr(ANY)]) {
      expect(isAssignable(k, closed)).toBe(false);
      expect(isAssignable(closed, k)).toBe(false);
    }
  });

  it('GM-7: isAssignable is transitive over the corpus (all triples a->b, b->c implies a->c)', () => {
    const corpus = buildCorpus();
    const n = corpus.length;
    const matrix: boolean[][] = corpus.map((from) => corpus.map((to) => isAssignable(from, to)));
    const edge = (i: number, j: number): boolean => matrix[i]?.[j] === true;

    let nontrivial = 0;
    const violations: string[] = [];
    const anyIndex = corpus.findIndex((s) => Object.keys(s).length === 0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (!edge(a, b)) continue;
        for (let c = 0; c < n; c++) {
          if (!edge(b, c)) continue;
          if (a !== b && b !== c && a !== c && a !== anyIndex && b !== anyIndex && c !== anyIndex) nontrivial++;
          if (!edge(a, c)) violations.push(`${json(corpus[a])} -> ${json(corpus[b])} -> ${json(corpus[c])}`);
        }
      }
    }
    // guard against a vacuous pass: the corpus must actually contain chains
    expect(nontrivial).toBeGreaterThanOrEqual(15);
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('GM-7: isAssignable is sound: whenever it says yes, every generated value of the source conforms to the target (seeded)', () => {
    const corpus = buildCorpus();
    const rng = mulberry32(20_260_501);
    const failures: string[] = [];
    let yes = 0;
    for (const from of corpus) {
      const values = Array.from({ length: 14 }, () => genFor(from, rng)).filter((value) => value !== undefined); // a source that accepts nothing is vacuously assignable
      for (const to of corpus) {
        if (!isAssignable(from, to)) continue;
        yes++;
        for (const value of values) {
          if (!conformsTo(value, to)) {
            failures.push(`${json(value)} from ${json(from)} but not ${json(to)}`);
            break;
          }
        }
      }
    }
    expect(yes).toBeGreaterThan(250);
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Robustness: immutability, depth, size
// ---------------------------------------------------------------------------------------------------------------------

describe('T11: robustness', () => {
  it('T11: no function mutates its inputs (snapshot comparison)', () => {
    const samples: JsonValue[] = ['b', 1, null, 2.5, 'a', [2, 1], { b: 1, a: [{ z: 1, y: null }] }, { c: 'x', b: 2 }];
    const schemas: Schema[] = [
      obj({ b: INT, a: arr(obj({ z: NUM, y: NUL }, ['z', 'y'])) }, ['b', 'a']),
      obj({ b: NUM, a: arr(ANY), c: STR }, ['a', 'b']),
      anyOf(STR, INT, NUL, arr(INT), obj({ b: INT }, ['b'], false)),
      en({ b: 1, a: [2, 1] }, 'z', null),
      arr(anyOf(NUM, STR)),
      ...buildCorpus(),
    ];
    const before = json([samples, schemas]);
    inferSchema(samples);
    for (const sample of samples) for (const schema of schemas) conformsTo(sample, schema);
    for (const from of schemas) for (const to of schemas) isAssignable(from, to);
    expect(json([samples, schemas])).toBe(before);
  });

  it('T11: frozen inputs are accepted (nothing writes to them)', () => {
    const samples = deepFreeze<JsonValue[]>(['b', 1, null, 2.5, [2, 1], { b: 1, a: [{ z: 1 }] }, { c: 'x', b: 2 }]);
    const schemas = deepFreeze(JSON.parse(json(buildCorpus())) as Schema[]);
    expect(() => inferSchema(samples)).not.toThrow();
    expect(() => {
      for (const sample of samples) for (const schema of schemas) conformsTo(sample, schema);
    }).not.toThrow();
    expect(() => {
      for (const from of schemas) for (const to of schemas) isAssignable(from, to);
    }).not.toThrow();
    const inferred = inferSchema(samples);
    expect(samples.every((sample) => conformsTo(sample, inferred))).toBe(true);
  });
});

const DEPTH = 50_000;

const deepArrays = (depth: number, leaf: JsonValue): JsonValue => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
const deepObjects = (depth: number, leaf: JsonValue): JsonValue => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
};
const deepAlternating = (depth: number, leaf: JsonValue): JsonValue => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? [v] : { a: v };
  return v;
};
const deepArraySchema = (depth: number, leaf: Schema): Schema => {
  let s = leaf;
  for (let i = 0; i < depth; i++) s = arr(s);
  return s;
};
const deepObjectSchema = (depth: number, leaf: Schema): Schema => {
  let s = leaf;
  for (let i = 0; i < depth; i++) s = obj({ a: s }, ['a']);
  return s;
};
const deepAlternatingSchema = (depth: number, leaf: Schema): Schema => {
  let s = leaf;
  for (let i = 0; i < depth; i++) s = i % 2 === 0 ? arr(s) : obj({ a: s }, ['a']);
  return s;
};

// Peels array/object wrappers without recursion; returns the wrapper count and the schema at the bottom.
const peel = (s: Schema): readonly [depth: number, leaf: Schema] => {
  let depth = 0;
  let cur = s;
  for (;;) {
    if (isArraySchema(cur)) cur = cur.items;
    else if (isObjectSchema(cur) && cur.properties['a'] !== undefined) cur = cur.properties['a'];
    else return [depth, cur];
    depth++;
  }
};

describe('T11: deep nesting does not overflow the stack', () => {
  const builders: ReadonlyArray<readonly [string, (d: number, leaf: JsonValue) => JsonValue, (d: number, leaf: Schema) => Schema]> = [
    ['arrays', deepArrays, deepArraySchema],
    ['objects', deepObjects, deepObjectSchema],
    ['alternating', deepAlternating, deepAlternatingSchema],
  ];

  it('T11: conformsTo handles deep values and deep schemas', () => {
    for (const [name, value, schema] of builders) {
      expect(conformsTo(value(DEPTH, 1), schema(DEPTH, INT)), `${name} conforming`).toBe(true);
      expect(conformsTo(value(DEPTH, 'x'), schema(DEPTH, INT)), `${name} wrong leaf`).toBe(false);
      expect(conformsTo(value(DEPTH, 1), schema(DEPTH - 1, INT)), `${name} value deeper than schema`).toBe(false);
      expect(conformsTo(value(DEPTH - 1, 1), schema(DEPTH, INT)), `${name} schema deeper than value`).toBe(false);
      expect(conformsTo(value(DEPTH, 1), ANY), `${name} any`).toBe(true);
      expect(conformsTo(value(DEPTH, 1), anyOf(STR, schema(DEPTH, NUM))), `${name} anyOf`).toBe(true);
    }
  }, 30_000);

  it('T11: conformsTo compares deep enum members iteratively', () => {
    expect(conformsTo(deepArrays(DEPTH, 1), en(deepArrays(DEPTH, 1)))).toBe(true);
    expect(conformsTo(deepArrays(DEPTH, 1), en(deepArrays(DEPTH, 2)))).toBe(false);
    expect(conformsTo(deepObjects(DEPTH, 1), en(deepObjects(DEPTH, 1)))).toBe(true);
    expect(conformsTo(deepObjects(DEPTH, 1), en(deepObjects(DEPTH, 'x')))).toBe(false);
    expect(conformsTo(deepAlternating(DEPTH, null), en(deepAlternating(DEPTH, null)))).toBe(true);
    expect(conformsTo(deepAlternating(DEPTH, null), en(deepAlternating(DEPTH, false)))).toBe(false);
  }, 30_000);

  it('T11: inferSchema handles deep samples and its result conforms', () => {
    for (const [name, value] of builders) {
      const samples = [value(DEPTH, 1), value(DEPTH, 2.5)];
      const schema = inferSchema(samples);
      const [depth, leaf] = peel(schema);
      expect(depth, `${name} depth`).toBe(DEPTH);
      expect(leaf, `${name} leaf`).toEqual(NUM);
      for (const sample of samples) expect(conformsTo(sample, schema), `${name} sample`).toBe(true);
    }
  }, 30_000);

  it('T11: inferSchema merges deep samples of different kinds at the bottom and of different depths', () => {
    const mixedLeaf = inferSchema([deepArrays(DEPTH, 1), deepArrays(DEPTH, 'x')]);
    const [depth, leaf] = peel(mixedLeaf);
    expect(depth).toBe(DEPTH);
    expect(leaf).toEqual(anyOf(INT, STR));

    const kinds = inferSchema([deepArrays(DEPTH, 1), deepObjects(DEPTH, 1)]);
    expect(isAnyOfSchema(kinds) && kinds.anyOf.length).toBe(2);
    expect(conformsTo(deepArrays(DEPTH, 1), kinds)).toBe(true);
    expect(conformsTo(deepObjects(DEPTH, 1), kinds)).toBe(true);

    const differentDepths = inferSchema([deepArrays(DEPTH, 1), deepArrays(DEPTH / 2, 1)]);
    expect(conformsTo(deepArrays(DEPTH, 1), differentDepths)).toBe(true);
    expect(conformsTo(deepArrays(DEPTH / 2, 1), differentDepths)).toBe(true);
  }, 30_000);

  it('T11: isAssignable handles deep schemas', () => {
    for (const [name, , schema] of builders) {
      expect(isAssignable(schema(DEPTH, INT), schema(DEPTH, INT)), `${name} reflexive`).toBe(true);
      expect(isAssignable(schema(DEPTH, INT), schema(DEPTH, NUM)), `${name} covariant`).toBe(true);
      expect(isAssignable(schema(DEPTH, NUM), schema(DEPTH, INT)), `${name} not contravariant`).toBe(false);
      expect(isAssignable(schema(DEPTH, INT), schema(DEPTH - 1, INT)), `${name} depth mismatch`).toBe(false);
      expect(isAssignable(schema(DEPTH, INT), ANY), `${name} to any`).toBe(true);
      expect(isAssignable(schema(DEPTH, INT), anyOf(STR, schema(DEPTH, NUM))), `${name} to anyOf`).toBe(true);
    }
    expect(isAssignable(en(deepArrays(DEPTH, 1)), deepArraySchema(DEPTH, INT))).toBe(true);
    expect(isAssignable(en(deepArrays(DEPTH, 'x')), deepArraySchema(DEPTH, INT))).toBe(false);
    expect(isAssignable(en(deepObjects(DEPTH, 1)), deepObjectSchema(DEPTH, INT))).toBe(true);
  }, 30_000);
});

describe('T11: large inputs run in linear time', () => {
  const N = 100_000;
  // Linear-time guard that holds on a loaded machine. An absolute wall-clock budget either flakes under CPU contention
  // or, made generous, misses a cheap quadratic scan (a plain 100k x 100k loop takes ~7 s), so compare like with like:
  // ONE call at N against TEN calls at N/10 (the same total work if linear), interleaved, after a warm-up. Linear code
  // stays below ~3x (GC and hash-table growth, CPU contention); a quadratic regression shows ~8-20x. A borderline
  // attempt is retried (up to three); a clearly superlinear one fails at once. The 25 ms floor absorbs timer resolution.
  const MAX_GROWTH = 4;
  const FLOOR_MS = 25;
  const elapsed = (fn: () => unknown): number => {
    const start = Date.now();
    fn();
    return Date.now() - start;
  };
  const expectLinear = <T>(label: string, make: (n: number) => T, run: (input: T) => unknown): void => {
    const big = make(N);
    const small = make(N / 10);
    run(small);
    const attempts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const tenSmall = elapsed(() => {
        for (let k = 0; k < 10; k++) run(small);
      });
      const oneBig = elapsed(() => run(big));
      const growth = oneBig / Math.max(tenSmall, FLOOR_MS);
      if (growth <= MAX_GROWTH) return;
      attempts.push(`${oneBig} ms for n=${N} vs ${tenSmall} ms for 10 x n=${N / 10}`);
      if (growth > 2 * MAX_GROWTH) break;
    }
    expect(attempts, `${label} grows faster than linearly`).toEqual([]);
  };
  const ints = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
  const wideValue = (n: number): Record<string, JsonValue> => {
    const value: Record<string, JsonValue> = {};
    for (let i = 0; i < n; i++) value[`k${i}`] = i;
    return value;
  };
  const wideSchema = (n: number, leaf: Schema, additionalProperties?: boolean): Schema => {
    const properties: Record<string, Schema> = {};
    for (let i = 0; i < n; i++) properties[`k${i}`] = leaf;
    return obj(properties, Object.keys(properties), additionalProperties);
  };

  it('T11: inferSchema over 100k flat samples', () => {
    const mixed = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => (i % 3 === 0 ? i : i % 3 === 1 ? `s${i}` : null));
    const records = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => ({ id: i, name: `n${i}`, tags: [`t${i}`] }));
    expectLinear('inferSchema(integers)', ints, inferSchema);
    expectLinear('inferSchema(mixed kinds)', mixed, inferSchema);
    expectLinear('inferSchema(records)', records, inferSchema);
    expect(inferSchema(ints(N))).toEqual(INT);
    expect(inferSchema(mixed(N))).toEqual(anyOf(NUL, INT, STR));
    expect(inferSchema(records(N))).toEqual(obj({ id: INT, name: STR, tags: arr(STR) }, ['id', 'name', 'tags']));
  }, 60_000);

  it('T11: inferSchema over 100k samples with pairwise-distinct keys, and over one very wide object', () => {
    const distinct = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => ({ [`k${i}`]: i }));
    const pairs = (n: number): JsonValue[] => Array.from({ length: n }, (_, i): JsonValue => [i, i + 0.5]);
    expectLinear('inferSchema(distinct keys)', distinct, inferSchema);
    expectLinear('inferSchema([wide object])', (n) => [wideValue(n)], inferSchema);
    expectLinear('inferSchema(pairs)', pairs, inferSchema);
    expectLinear('inferSchema([long array])', (n) => [ints(n)], inferSchema);
    const a = inferSchema(distinct(N));
    expect(Object.keys(propsOf(a))).toHaveLength(N);
    expect(requiredOf(a)).toEqual([]);
    const b = inferSchema([wideValue(N)]);
    expect(Object.keys(propsOf(b))).toHaveLength(N);
    expect(requiredOf(b)).toHaveLength(N);
    expect(inferSchema(pairs(N))).toEqual(arr(NUM));
    expect(inferSchema([ints(N)])).toEqual(arr(INT));
  }, 60_000);

  it('T11: conformsTo over a 100k-item array, a 100k-key object with 100k required keys, and a 100k-member enum and anyOf', () => {
    expectLinear('conformsTo(array)', ints, (items) => conformsTo(items, arr(INT)));
    expectLinear('conformsTo(wide object)', (n) => [wideValue(n), wideSchema(n, INT)] as const, ([v, s]) => conformsTo(v, s));
    expect(conformsTo(ints(N), arr(INT))).toBe(true);
    expect(conformsTo([...ints(N), 'x'], arr(INT))).toBe(false);
    const value = wideValue(N);
    const schema = wideSchema(N, INT);
    expect(conformsTo(value, schema)).toBe(true);
    const rest = { ...value };
    delete rest['k0'];
    expect(conformsTo(rest, schema)).toBe(false);
    expect(conformsTo({ ...value, extra: 1 }, wideSchema(N, INT, false))).toBe(false);

    const members = Array.from({ length: N }, (_, i) => `m${i}`);
    expect(conformsTo(`m${N - 1}`, { enum: members })).toBe(true);
    expect(conformsTo('nope', { enum: members })).toBe(false);
    const alternatives = Array.from({ length: N }, (): Schema => STR);
    expect(conformsTo(1, { anyOf: [...alternatives, INT] })).toBe(true);
    expect(conformsTo(null, { anyOf: [...alternatives, INT] })).toBe(false);
  }, 60_000);

  it('T11: isAssignable over 100k-property objects, 100k required keys and a 100k-member anyOf', () => {
    const members = (n: number): Schema => ({ anyOf: Array.from({ length: n }, (): Schema => INT) });
    expectLinear('isAssignable(wide objects)', (n) => [wideSchema(n, INT), wideSchema(n, NUM)] as const, ([from, to]) => isAssignable(from, to));
    expectLinear('isAssignable(anyOf source)', members, (from) => isAssignable(from, NUM));
    const narrow = wideSchema(N, INT);
    const wider = wideSchema(N, NUM);
    expect(isAssignable(narrow, wider)).toBe(true);
    expect(isAssignable(wider, narrow)).toBe(false);
    const required = requiredOf(narrow);
    expect(isAssignable(obj(propsOf(narrow), required.slice(1)), wider)).toBe(false);
    expect(isAssignable(wideSchema(N, INT, false), wideSchema(N, NUM, false))).toBe(true);

    expect(isAssignable(members(N), NUM)).toBe(true);
    expect(isAssignable({ anyOf: [...Array.from({ length: N }, (): Schema => INT), STR] }, NUM)).toBe(false);
    expect(isAssignable(INT, { anyOf: [...Array.from({ length: N }, (): Schema => STR), NUM] })).toBe(true);
    expect(isAssignable({ enum: Array.from({ length: N }, (_, i) => i) }, INT)).toBe(true);
  }, 60_000);
});

describe('T11: pins for surviving mutants', () => {
  it('GM-7: an open source may omit a property the target types as the any-schema, unless the target requires it', () => {
    expect(assignabilityMisses([
      [obj({}), obj({ a: ANY }), true],
      [obj({ b: STR }), obj({ a: ANY, b: STR }), true],
      [obj({}, [], true), obj({ a: ANY }), true],
      [obj({}), obj({ a: ANY }, ['a']), false],
    ])).toEqual([]);
  });

  it('GM-6: integral numbers beyond 2^53 still infer integer, in step with conformsTo', () => {
    for (const big of [2 ** 53, 2 ** 53 + 2, 1e21, 1e300]) {
      expect(inferSchema([big]), String(big)).toEqual(INT);
      expect(conformsTo(big, INT), String(big)).toBe(true);
    }
    expect(inferSchema([2 ** 53, 0.5])).toEqual(NUM);
  });

  it('T11: a schema with an unknown type accepts nothing (fail closed; parseFlow rejects it before it gets here)', () => {
    const unknownType = { type: 'date' } as unknown as Schema;
    expect(accepted(unknownType)).toEqual([]);
    expect(isAssignable(STR, unknownType)).toBe(false);
    expect(isAssignable(unknownType, ANY)).toBe(true);
  });

  it('T11: a closed object that requires a key it does not define is unsatisfiable, as target and in conformsTo', () => {
    const unsatisfiable = obj({}, ['x'], false);
    expect(conformsTo({ x: 1 }, unsatisfiable)).toBe(false);
    expect(conformsTo({}, unsatisfiable)).toBe(false);
    expect(isAssignable(obj({ x: INT }, ['x'], false), unsatisfiable)).toBe(false);
    expect(isAssignable(obj({ x: INT }, ['x'], false), obj({ y: INT }, ['x'], false))).toBe(false);
  });
});
