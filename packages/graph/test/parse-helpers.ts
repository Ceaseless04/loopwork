import { expect } from 'vitest';
import { parseFlow } from '../src/parse.js';
import type { ParseResult, ValidationError } from '../src/types.js';

// Shared fixtures and helpers of the parseFlow test files (parse*.test.ts).

export type Rec = Record<string, unknown>;
export const GONE = Symbol('gone');

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------------------------------

export const budgets = (): Rec => ({ maxIterations: 100, maxDurationMs: 60_000, maxCostUsd: 1.5, maxTokens: 1000 });
export const ref = (node: string, port: string): Rec => ({ node, port });
export const edge = (fromNode: string, fromPort: string, toNode: string, toPort: string): Rec => ({
  from: ref(fromNode, fromPort),
  to: ref(toNode, toPort),
});
export const mapNode = (): Rec => ({ kind: 'map', fn: 'dbl', in: { type: 'integer' }, out: { type: 'integer' }, concurrency: 2 });
export const body = (scope: string, extraNodes: Rec = {}): Rec => ({
  nodes: { a: mapNode(), b: mapNode(), ...extraNodes },
  edges: [edge(`${scope}.a`, 'out', `${scope}.b`, 'in')],
  entry: ref(`${scope}.a`, 'in'),
  exit: ref(`${scope}.b`, 'out'),
});
export const frameCommon = (scope: string, extraNodes?: Rec): Rec => ({
  kind: 'frame',
  budgets: budgets(),
  in: { type: 'array', items: { type: 'integer' } },
  out: { type: 'array', items: { type: 'integer' } },
  body: body(scope, extraNodes),
});

export const validFlow = (): Rec => ({
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

export const SRC = ['nodes', 'src'];
export const MAP = ['nodes', 'm'];
export const SNK = ['nodes', 'snk'];
export const FE = ['nodes', 'fe'];
export const WH = ['nodes', 'wh'];
export const UN = ['nodes', 'un'];
export const RT = ['nodes', 'rt'];
export const INNER = [...WH, 'body', 'nodes', 'inner'];
export const SRC_OUT = [...SRC, 'out'];

// Every PortSpec position of validFlow.
export const PORTS: string[][] = [
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

export const get = (root: unknown, at: readonly string[]): unknown => at.reduce<unknown>((cur, key) => (cur as Rec)[key], root);

export const edit = (flow: Rec, at: readonly string[], value: unknown): Rec => {
  const last = at[at.length - 1];
  if (last === undefined) throw new Error('edit needs a non-empty location');
  const parent = get(flow, at.slice(0, -1)) as Rec;
  if (value === GONE) delete parent[last];
  else parent[last] = value;
  return flow;
};

// Freezes everything reachable (iteratively, cycle-safe, own data properties only), so any mutation by parseFlow throws.
export const deepFreeze = <T>(root: T): T => {
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
export const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Rec)[k])]));
  return v;
};

// canon as tagged, sorted [key, value] pairs. toStrictEqual also compares the `constructor` PROPERTY of both sides, which can
// never match for objects with an own `constructor` key (hostile data); pairs have no such key and stay strict (undefined
// values and the array/object distinction are kept).
export const pairs = (v: unknown): unknown => {
  if (Array.isArray(v)) return ['array', v.map(pairs)];
  if (typeof v === 'object' && v !== null) return ['object', Object.keys(v).sort().map((k) => [k, pairs((v as Rec)[k])])];
  return v;
};

export const run = (input: unknown): ParseResult => parseFlow(deepFreeze(input));
export const parsed = (input: unknown): Rec => {
  const result: ParseResult = run(input);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors.slice(0, 3))}`);
  return result.flow as unknown as Rec;
};
export const errorsOf = (input: unknown): ValidationError[] => {
  const result = run(input);
  expect(result.ok, 'parseFlow should reject this input').toBe(false);
  return result.ok ? [] : result.errors;
};
export const brief = (errors: ValidationError[]): Array<{ code: string; path: string }> => errors.map((e) => ({ code: e.code, path: e.path }));
export const pathsOf = (input: unknown): string[] => errorsOf(input).map((e) => e.path);

// The invariants of every failure: E_SHAPE only, messages, unique (code, path), sorted by path in plain string order.
export const expectWellFormed = (errors: ValidationError[]): void => {
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

export const hasKeyDeep = (root: unknown, key: string): boolean => {
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

export const objectsOf = (root: unknown): Set<object> => {
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

export type Rng = () => number;
export const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const shuffled = <T>(rng: Rng, xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
};

export const VALID_SCHEMAS: Rec[] = [
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

export const DEEP = 20_000;
export const WIDE = 100_000;

export const deepArrays = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};
export const deepObjects = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
};
export const deepAlternating = (depth: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? [v] : { a: v };
  return v;
};
export const peelJson = (v: unknown): { depth: number; leaf: unknown } => {
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
export type DeepSchema = { schema: Rec; suffix: string };
export const deepSchema = (kind: 'arrays' | 'objects' | 'alternating', depth: number, leaf: Rec): DeepSchema => {
  let schema = leaf;
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) {
    const asArray = kind === 'arrays' || (kind === 'alternating' && i % 2 === 0);
    schema = asArray ? { type: 'array', items: schema } : { type: 'object', properties: { a: schema }, required: ['a'] };
    parts.push(asArray ? '/items' : '/properties/a');
  }
  return { schema, suffix: parts.reverse().join('') };
};
export const peelSchema = (s: unknown): { depth: number; leaf: unknown } => {
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

export const nestedFrames = (depth: number, leaf: Rec): Rec => {
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
export const peelFrames = (flow: Rec): { depth: number; leaf: unknown } => {
  let depth = 0;
  let cur: unknown = (flow['nodes'] as Rec)['f'];
  while ((cur as Rec)['kind'] === 'frame') {
    depth++;
    cur = (((cur as Rec)['body'] as Rec)['nodes'] as Rec)['f'];
  }
  return { depth, leaf: cur };
};

export const MAX_ERRORS = 250_000;
export const MAX_WORK = 5_000_000;
// No deep-freeze and no helper that walks the result: these inputs are large on purpose.
export const outcome = (input: unknown): ValidationError[] => {
  const r: ParseResult = parseFlow(input);
  expect(r.ok, 'a limit is never a false ok:true').toBe(false);
  return r.ok ? [] : r.errors;
};
// The one error a limit adds: at the root, whatever else was found.
export const limitError = (errors: ValidationError[], message: RegExp): void => {
  const at = errors.filter((e) => e.path === '');
  expect(at).toHaveLength(1);
  expect(at[0]?.code).toBe('E_SHAPE');
  expect(at[0]?.message).toMatch(message);
  expect(at[0]).not.toHaveProperty('node');
};
export const pointer = (at: readonly string[]): string => at.map((p) => `/${p}`).join('');
export const TOO_LARGE = /input too large/;
export const TOO_MANY = /too many errors/;
export const withSamples = (samples: unknown): Rec => edit(validFlow(), SRC_OUT, { inferFrom: samples });
export const lyingLength = (length: number): unknown[] => new Proxy([], { get: (t, k, r) => (k === 'length' ? length : Reflect.get(t, k, r)) });
export const dagBomb = (levels: number): Rec => {
  let schema: Rec = { type: 'string' };
  for (let i = 0; i < levels; i++) schema = { anyOf: [schema, schema] };
  return edit(validFlow(), SRC_OUT, schema);
};
export const badEdges = (n: number): Rec => ({ version: 1, id: 'f', name: 'f', nodes: {}, edges: Array.from({ length: n }, () => ({ from: ref('a', 'out') })) });
// The fixed cost of this flow is 20 work units (the root, the node and its params array: reads and container tasks), so
// the largest params array that parses is MAX_WORK - 20 elements, one more is over: the limit is exact, neither off by
// one nor padded.
export const withParams = (params: unknown): Rec => ({ version: 1, id: 'f', name: 'f', nodes: { s: { kind: 'source', fn: 'g', params, out: {} } }, edges: [] });
// --- the text of the errors is work too -------------------------------------------------------------------------------

export const jsonSchemaChain = (n: number): unknown =>
  JSON.parse(`{"version":1,"id":"x","name":"x","edges":[],"nodes":{"s":{"kind":"source","fn":"g","out":${'{"type":"array","x":1,"items":'.repeat(n)}{"type":"integer"}${'}'.repeat(n)}}}}`);
export const jsonFrameChain = (n: number): unknown => {
  const open = '{"kind":"frame","frame":"foreach","budgets":{},"in":{},"body":{"edges":[],"entry":{"node":"f","port":"in"},"exit":{"node":"f","port":"out"},"nodes":{"f":';
  return JSON.parse(`{"version":1,"id":"x","name":"x","edges":[],"nodes":{"f":${open.repeat(n)}{"kind":"map","fn":"g","in":{},"out":{}}${'}}}'.repeat(n)}}}`);
};
// Monotonic clock (Date.now steps with NTP/WSL resume) and best of three, as perf.test.ts does: a stalled run is retried,
// but an exponential expansion blows the budget in every run. Stops at the first run inside the budget.
export const withinSeconds = (seconds: number, run: () => ValidationError[]): ValidationError[] => {
  let best = Infinity;
  let errors: ValidationError[] = [];
  for (let i = 0; i < 3 && best >= seconds * 1000; i++) {
    const start = performance.now();
    errors = run();
    best = Math.min(best, performance.now() - start);
  }
  expect(best).toBeLessThan(seconds * 1000);
  return errors;
};
// What is kept is bounded: the characters of the recorded errors stay near the work limit (each error may carry a little free).
export const expectBoundedText = (errors: ValidationError[]): void => {
  const chars = errors.reduce((sum, e) => sum + e.path.length + e.message.length + (e.node?.length ?? 0), 0);
  expect(chars).toBeLessThan(MAX_WORK + 300 * errors.length);
};
