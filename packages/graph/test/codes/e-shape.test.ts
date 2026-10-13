import { describe, expect, it } from 'vitest';
import { parseFlow } from '../../src/parse.js';
import { ERROR_CODES } from '../../src/types.js';
import type { ParseResult, ValidationError } from '../../src/types.js';

// GM-2, E_SHAPE: one table row per way a flow can fail the structural parse, each asserting the exact `code`, the exact
// `path` (RFC 6901 JSON Pointer into the INPUT flow, root = '') and the exact `node` (scoped id), in BOTH directions:
// the mutated flow fails with exactly that one error, and the near-identical valid shape passes.
//
// Decisions pinned here that the spec and the task brief leave open (the reviewer checks these against the spec):
//  - A MISSING field is reported at the path the field would have (`/nodes/src/fn`), not at its parent.
//  - A value of the wrong JSON type is reported at that value's own path. An absent or out-of-range value of a SEMANTIC
//    field is NOT E_SHAPE (validateFlow owns it); a wrong type there IS (null, boolean, string, object, array all count).
//    Semantic fields: budgets.maxIterations, budgets.maxDurationMs, node `concurrency` (map, sink, foreach), while/until
//    `condition`, retry `maxAttempts`, retry `backoff.baseMs`. maxCostUsd / maxTokens are optional numbers: absent is ok.
//    A numeric field holding NaN, Infinity or -Infinity is a wrong type too (they are not JSON), at that field's path;
//    finite out-of-range numbers (0, negative, 1.5) stay ok:true. A key that is PRESENT but holds `undefined` (params,
//    concurrency, any field) is E_SHAPE at that key's path, exactly like `{ a: undefined }` inside a JSON value; an ABSENT key
//    is fine where the field is optional.
//  - UNKNOWN EXTRA KEYS are E_SHAPE at `<object path>/<key>` (RFC 6901-escaped key) on the flow root, every node kind, bodies,
//    budgets, backoff, edges and PortRefs, with the `node` of the enclosing node; the value of an unknown key is never
//    examined (one error whatever it holds, even `undefined`). Typos of real optional fields (`concurency`, `maxIteration`,
//    `onExhausted2`) and keys named like Object.prototype members (`__proto__`, `constructor`) count as unknown. Keys that
//    belong to another node kind or frame variant are unknown too (`in` on a source, `fn` on a frame, `maxAttempts` on a
//    foreach, `concurrency` on a retry, `condition` on a foreach, `backoff` on a while, `onExhausted` on a foreach).
//    `maxCostUsd` / `maxTokens` stay allowed in budgets, and `params` on source/map/sink. Schemas keep their own rules.
//  - Where the variant is UNRESOLVED (node `kind` missing or unknown, `frame` missing or unknown) the keys of ALL kinds (resp.
//    all frame variants) are tolerated, so the one error stays at `kind` / `frame`; a key outside that union is still unknown.
//    An unknown backoff `kind` tolerates `baseMs`.
//  - Shared/DAG inputs (one object reachable from several places) are expanded, but parseFlow's work (5,000,000 values) and error
//    count (250,000) are bounded: the limits are pinned in parse.test.ts, not here.
//  - Structural fields (absence IS E_SHAPE): version, id, name, nodes, edges, node kind, fn, in/out of the kinds that
//    have them, frame, body, budgets (an object, possibly empty), body.nodes/edges/entry/exit, PortRef node and port,
//    retry `backoff` (an object with a `kind` literal) and retry `onExhausted`.
//  - A schema is exactly ONE union member. If two or more of `type` / `anyOf` / `enum` / `inferFrom` are present, ONE
//    error at the schema's own path. Any other key that does not belong to the member (pattern, $ref, a stray
//    `items` on a string, ...) is an error at THAT KEY's path. `array` without `items` is an error at `<schema>/items`,
//    `object` without `properties` at `<schema>/properties`, empty `anyOf`/`enum` at `<schema>/anyOf` / `<schema>/enum`.
//  - `{ inferFrom }` is only a PortSpec: nested inside a schema (items, properties, anyOf) it is an unsupported keyword.
//  - A non-JSON value (undefined, function, symbol, bigint, NaN, Infinity, Date, Map, Set, class instance, boxed
//    primitive, typed array, RegExp, Error, Promise, object with a custom prototype, sparse-array hole) is reported at
//    its own path, in `inferFrom` samples, `enum` members and node `params` alike. A hole is reported at its index.
//  - `node` is present exactly when the error lies at or under a node entry and is the scoped id (`frame.inner.x`) of
//    the nearest enclosing node (the frame itself for errors in its body.entry/exit/edges); root and `edges` errors have
//    no `node` property at all.

type Rec = Record<string, unknown>;
const GONE = Symbol('gone');

class Point {
  x = 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
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

// A flow that is valid in every respect parseFlow checks: all three plain kinds, all four frames, a nested frame.
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

// Sets (or, with GONE, deletes) the value at `at` inside `flow`; returns the flow.
const edit = (flow: Rec, at: readonly string[], value: unknown): Rec => {
  const last = at[at.length - 1];
  if (last === undefined) throw new Error('edit needs a non-empty location');
  const parent = at.slice(0, -1).reduce<unknown>((cur, key) => (cur as Rec)[key], flow) as Rec;
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

const run = (input: unknown): ParseResult => parseFlow(deepFreeze(input));
const accepts = (input: unknown): boolean => run(input).ok;
const errorsOf = (input: unknown): ValidationError[] => {
  const result = run(input);
  expect(result.ok, 'parseFlow should reject this input').toBe(false);
  return result.ok ? [] : result.errors;
};

// Exactly one error, E_SHAPE, at `path`, about `node` (undefined: no `node` property at all).
const expectOne = (input: unknown, path: string, node: string | undefined): void => {
  const errors = errorsOf(input);
  expect(errors.map((e) => ({ code: e.code, path: e.path }))).toEqual([{ code: 'E_SHAPE', path }]);
  const [error] = errors;
  expect(typeof error?.message === 'string' && error.message.length > 0, 'message is a non-empty string').toBe(true);
  expect(error?.node, 'node').toBe(node);
  expect(error !== undefined && 'node' in error, 'node property present').toBe(node !== undefined);
};

// The scoped id of the node an `at` location lies in: nodes/<id>(/body/nodes/<id>)*, undefined outside any node.
const nodeOf = (at: readonly string[]): string | undefined => {
  const first = at[1];
  if (at[0] !== 'nodes' || first === undefined) return undefined;
  const ids = [first];
  for (let i = 2; at[i] === 'body' && at[i + 1] === 'nodes' && at[i + 2] !== undefined; i += 3) ids.push(at[i + 2] as string);
  return ids.join('.');
};
const pointer = (at: readonly string[]): string => at.map((s) => `/${s}`).join('');

// ---------------------------------------------------------------------------------------------------------------------
// The code table and the fixture
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE fixture and code', () => {
  it('GM-2: E_SHAPE is one of the stable error codes', () => {
    expect(ERROR_CODES).toContain('E_SHAPE');
  });

  it('GM-2: E_SHAPE the valid base flow every table row mutates parses ok', () => {
    const result = run(validFlow());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Non-object input
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE non-object input', () => {
  const cases: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['true', () => true],
    ['a number', () => 1],
    ['NaN', () => NaN],
    ['a string', () => 'flow'],
    ['the JSON text of a valid flow (strings are not parsed)', () => JSON.stringify(validFlow())],
    ['a bigint', () => 1n],
    ['a symbol', () => Symbol('flow')],
    ['an empty array', () => []],
    ['an array holding a valid flow', () => [validFlow()]],
    ['a function', () => () => validFlow()],
    ['a function carrying the flow fields', () => Object.defineProperties(() => 1, Object.getOwnPropertyDescriptors(validFlow()))],
    ['a class instance', () => new Point()],
    ['a class instance carrying the flow fields', () => Object.assign(new Point(), validFlow())],
    ['an object that inherits the flow fields', () => Object.create(validFlow())],
    ['a Map', () => new Map(Object.entries(validFlow()))],
    ['a Date', () => new Date(0)],
    ['a boxed string', () => new String('flow')],
    ['a Promise', () => Promise.resolve(validFlow())],
  ];

  it.each(cases)('GM-2: E_SHAPE rejects %s at the root', (_name, make) => {
    expectOne(make(), '', undefined);
  });

  it('GM-2: E_SHAPE accepts a plain object, a null-prototype object and a JSON.parse result', () => {
    expect(accepts(validFlow())).toBe(true);
    expect(accepts(Object.assign(Object.create(null), validFlow()))).toBe(true);
    expect(accepts(JSON.parse(JSON.stringify(validFlow())))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Table rows: mutate one location of the valid flow
// ---------------------------------------------------------------------------------------------------------------------

type Row = { name: string; at: readonly string[]; bad: unknown; path: string; good: readonly unknown[] };
const row = (name: string, at: readonly string[], bad: unknown, path: string, ...good: unknown[]): Row => ({ name, at, bad, path, good });

const checkRows = (title: string, rows: Row[]): void => {
  describe(title, () => {
    it.each(rows)('GM-2: E_SHAPE $name', ({ at, bad, path, good }) => {
      expectOne(edit(validFlow(), at, bad), path, nodeOf(at));
      for (const value of good) expect(accepts(edit(validFlow(), at, value)), `the near-identical valid shape ${String(value)}`).toBe(true);
    });
  });
};

const SRC = ['nodes', 'src'];
const MAP = ['nodes', 'm'];
const SNK = ['nodes', 'snk'];
const FE = ['nodes', 'fe'];
const WH = ['nodes', 'wh'];
const UN = ['nodes', 'un'];
const RT = ['nodes', 'rt'];
const INNER = [...WH, 'body', 'nodes', 'inner'];
checkRows('GM-2: E_SHAPE the flow root', [
  row('version 2', ['version'], 2, '/version', 1),
  row("version '1' (a string)", ['version'], '1', '/version', 1),
  row('version null', ['version'], null, '/version'),
  row('version true', ['version'], true, '/version'),
  row('version 1.5', ['version'], 1.5, '/version'),
  row('version 0', ['version'], 0, '/version'),
  row('version [1]', ['version'], [1], '/version'),
  row('version missing', ['version'], GONE, '/version', 1),
  row('version NaN', ['version'], Number.NaN, '/version', 1),
  row('version Infinity', ['version'], Infinity, '/version'),
  row('version present but undefined', ['version'], undefined, '/version', 1),
  row('id a number', ['id'], 5, '/id', 'other'),
  row('id null', ['id'], null, '/id'),
  row('id an object', ['id'], {}, '/id'),
  row('id missing', ['id'], GONE, '/id', 'other'),
  row('id present but undefined', ['id'], undefined, '/id', 'other'),
  row('name a number', ['name'], 5, '/name', 'other'),
  row('name an array', ['name'], ['x'], '/name'),
  row('name missing', ['name'], GONE, '/name', 'other'),
  row('nodes missing', ['nodes'], GONE, '/nodes', {}),
  row('nodes present but undefined', ['nodes'], undefined, '/nodes', {}),
  row('nodes null', ['nodes'], null, '/nodes'),
  row('nodes a string', ['nodes'], 'x', '/nodes'),
  row('nodes an array (not a record)', ['nodes'], [], '/nodes', {}),
  row('nodes a number', ['nodes'], 5, '/nodes'),
  row('nodes a Map', ['nodes'], new Map(), '/nodes'),
  row('edges missing', ['edges'], GONE, '/edges', []),
  row('edges present but undefined', ['edges'], undefined, '/edges', []),
  row('edges null', ['edges'], null, '/edges'),
  row('edges a string', ['edges'], 'x', '/edges'),
  row('edges an object (not an array)', ['edges'], {}, '/edges', []),
]);

checkRows('GM-2: E_SHAPE node entries and kinds', [
  row('node a number', SRC, 5, '/nodes/src'),
  row('node null', SRC, null, '/nodes/src'),
  row('node a string', SRC, 'source', '/nodes/src'),
  row('node an array', SRC, [], '/nodes/src'),
  row('node a class instance', SRC, new Point(), '/nodes/src'),
  row('node kind missing', [...SRC, 'kind'], GONE, '/nodes/src/kind', 'source'),
  row('node kind unknown', [...SRC, 'kind'], 'sorter', '/nodes/src/kind', 'source'),
  row('node kind wrong case', [...SRC, 'kind'], 'Source', '/nodes/src/kind', 'source'),
  row('node kind a number', [...SRC, 'kind'], 5, '/nodes/src/kind'),
  row('node kind null', [...SRC, 'kind'], null, '/nodes/src/kind'),
  row('node kind an array', [...SRC, 'kind'], ['source'], '/nodes/src/kind'),
  row('map kind unknown', [...MAP, 'kind'], 'mapper', '/nodes/m/kind'),
  row('sink kind unknown', [...SNK, 'kind'], 'drain', '/nodes/snk/kind'),
  row('frame kind unknown in a body', [...INNER, 'kind'], 'loop', '/nodes/wh/body/nodes/inner/kind'),
  row('nested body node a number', [...WH, 'body', 'nodes', 'a'], 5, '/nodes/wh/body/nodes/a'),
]);

checkRows('GM-2: E_SHAPE source, map and sink fields', [
  row('source fn missing', [...SRC, 'fn'], GONE, '/nodes/src/fn', 'gen'),
  row('source fn a number', [...SRC, 'fn'], 5, '/nodes/src/fn'),
  row('source fn null', [...SRC, 'fn'], null, '/nodes/src/fn'),
  row('source out missing', [...SRC, 'out'], GONE, '/nodes/src/out', {}),
  row('source out a number', [...SRC, 'out'], 5, '/nodes/src/out', {}),
  row('source out null', [...SRC, 'out'], null, '/nodes/src/out'),
  row('source out an array', [...SRC, 'out'], [], '/nodes/src/out'),
  row('source out a string', [...SRC, 'out'], 'string', '/nodes/src/out'),
  row('source params a function', [...SRC, 'params'], () => 1, '/nodes/src/params', GONE, null, 5, 'x', [1], { a: { b: null } }),
  row('source params present but undefined', [...SRC, 'params'], undefined, '/nodes/src/params', GONE, null),
  row('map params present but undefined', [...MAP, 'params'], undefined, '/nodes/m/params', GONE, null),
  row('sink params present but undefined', [...SNK, 'params'], undefined, '/nodes/snk/params', GONE, null),
  row('body map params present but undefined', [...FE, 'body', 'nodes', 'a', 'params'], undefined, '/nodes/fe/body/nodes/a/params', GONE, null),
  row('source params NaN', [...SRC, 'params'], Number.NaN, '/nodes/src/params', 0),
  row('source params holding -Infinity', [...SRC, 'params'], { a: [1, -Infinity] }, '/nodes/src/params/a/1', { a: [1, -1] }),
  row('source params holding undefined', [...SRC, 'params'], { a: undefined }, '/nodes/src/params/a', { a: null }),
  row('source params a Date', [...SRC, 'params'], new Date(0), '/nodes/src/params'),
  row('map fn missing', [...MAP, 'fn'], GONE, '/nodes/m/fn', 'dbl'),
  row('map fn a number', [...MAP, 'fn'], 5, '/nodes/m/fn'),
  row('map in missing', [...MAP, 'in'], GONE, '/nodes/m/in', {}),
  row('map in a string', [...MAP, 'in'], 'integer', '/nodes/m/in'),
  row('map out missing', [...MAP, 'out'], GONE, '/nodes/m/out', {}),
  row('map out a number', [...MAP, 'out'], 5, '/nodes/m/out'),
  row('map params a Map', [...MAP, 'params'], new Map(), '/nodes/m/params', { k: [] }),
  row('sink fn missing', [...SNK, 'fn'], GONE, '/nodes/snk/fn', 'save'),
  row('sink fn a boolean', [...SNK, 'fn'], true, '/nodes/snk/fn'),
  row('sink in missing', [...SNK, 'in'], GONE, '/nodes/snk/in', {}),
  row('sink in null', [...SNK, 'in'], null, '/nodes/snk/in'),
  row('sink params a Set', [...SNK, 'params'], new Set(), '/nodes/snk/params', null),
]);

checkRows('GM-2: E_SHAPE frames', [
  row('foreach frame missing', [...FE, 'frame'], GONE, '/nodes/fe/frame', 'foreach'),
  row('frame unknown', [...FE, 'frame'], 'loop', '/nodes/fe/frame', 'foreach'),
  row('frame wrong case', [...FE, 'frame'], 'Foreach', '/nodes/fe/frame'),
  row('frame a number', [...FE, 'frame'], 5, '/nodes/fe/frame'),
  row('frame null', [...FE, 'frame'], null, '/nodes/fe/frame'),
  row('while frame missing', [...WH, 'frame'], GONE, '/nodes/wh/frame', 'while'),
  row('until frame unknown', [...UN, 'frame'], 'for', '/nodes/un/frame', 'until'),
  row('retry frame missing', [...RT, 'frame'], GONE, '/nodes/rt/frame', 'retry'),
  row('nested frame unknown', [...INNER, 'frame'], 'loop', '/nodes/wh/body/nodes/inner/frame', 'foreach'),
  row('body missing', [...FE, 'body'], GONE, '/nodes/fe/body'),
  row('body a number', [...FE, 'body'], 5, '/nodes/fe/body'),
  row('body null', [...FE, 'body'], null, '/nodes/fe/body'),
  row('body an array', [...FE, 'body'], [], '/nodes/fe/body'),
  row('body a string', [...FE, 'body'], 'x', '/nodes/fe/body'),
  row('retry body missing', [...RT, 'body'], GONE, '/nodes/rt/body'),
  row('budgets missing', [...FE, 'budgets'], GONE, '/nodes/fe/budgets', {}, budgets()),
  row('budgets a number', [...FE, 'budgets'], 5, '/nodes/fe/budgets', {}),
  row('budgets null', [...FE, 'budgets'], null, '/nodes/fe/budgets'),
  row('budgets an array', [...FE, 'budgets'], [], '/nodes/fe/budgets'),
  row('budgets a string', [...FE, 'budgets'], 'x', '/nodes/fe/budgets'),
  row('while budgets missing', [...WH, 'budgets'], GONE, '/nodes/wh/budgets'),
  row('retry budgets null', [...RT, 'budgets'], null, '/nodes/rt/budgets'),
  row('frame in missing', [...FE, 'in'], GONE, '/nodes/fe/in', {}),
  row('frame in a number', [...FE, 'in'], 5, '/nodes/fe/in'),
  row('frame out missing', [...FE, 'out'], GONE, '/nodes/fe/out', {}),
  row('frame out null', [...FE, 'out'], null, '/nodes/fe/out'),
  row('while in missing', [...WH, 'in'], GONE, '/nodes/wh/in'),
  row('until out a string', [...UN, 'out'], 'x', '/nodes/un/out'),
  row('retry in missing', [...RT, 'in'], GONE, '/nodes/rt/in'),
  row('nested frame budgets missing', [...INNER, 'budgets'], GONE, '/nodes/wh/body/nodes/inner/budgets'),
  row('nested frame body missing', [...INNER, 'body'], GONE, '/nodes/wh/body/nodes/inner/body'),
]);

checkRows('GM-2: E_SHAPE bodies', [
  row('body nodes missing', [...FE, 'body', 'nodes'], GONE, '/nodes/fe/body/nodes', {}),
  row('body nodes an array', [...FE, 'body', 'nodes'], [], '/nodes/fe/body/nodes', {}),
  row('body nodes a string', [...FE, 'body', 'nodes'], 'x', '/nodes/fe/body/nodes'),
  row('body nodes null', [...FE, 'body', 'nodes'], null, '/nodes/fe/body/nodes'),
  row('body edges missing', [...FE, 'body', 'edges'], GONE, '/nodes/fe/body/edges', []),
  row('body edges an object', [...FE, 'body', 'edges'], {}, '/nodes/fe/body/edges', []),
  row('body edges a string', [...FE, 'body', 'edges'], 'x', '/nodes/fe/body/edges'),
  row('body edges null', [...FE, 'body', 'edges'], null, '/nodes/fe/body/edges'),
  row('body entry missing', [...FE, 'body', 'entry'], GONE, '/nodes/fe/body/entry', ref('fe.a', 'in')),
  row('body entry a string', [...FE, 'body', 'entry'], 'fe.a', '/nodes/fe/body/entry'),
  row('body entry null', [...FE, 'body', 'entry'], null, '/nodes/fe/body/entry'),
  row('body entry a number', [...FE, 'body', 'entry'], 5, '/nodes/fe/body/entry'),
  row('body entry an array', [...FE, 'body', 'entry'], ['fe.a', 'in'], '/nodes/fe/body/entry'),
  row('body entry node missing', [...FE, 'body', 'entry', 'node'], GONE, '/nodes/fe/body/entry/node', 'fe.a'),
  row('body entry node a number', [...FE, 'body', 'entry', 'node'], 5, '/nodes/fe/body/entry/node'),
  row('body entry node null', [...FE, 'body', 'entry', 'node'], null, '/nodes/fe/body/entry/node'),
  row('body entry node an object', [...FE, 'body', 'entry', 'node'], {}, '/nodes/fe/body/entry/node'),
  row('body entry port missing', [...FE, 'body', 'entry', 'port'], GONE, '/nodes/fe/body/entry/port', 'in'),
  row('body entry port a number', [...FE, 'body', 'entry', 'port'], 5, '/nodes/fe/body/entry/port'),
  row('body exit missing', [...FE, 'body', 'exit'], GONE, '/nodes/fe/body/exit', ref('fe.b', 'out')),
  row('body exit a string', [...FE, 'body', 'exit'], 'fe.b', '/nodes/fe/body/exit'),
  row('body exit node missing', [...FE, 'body', 'exit', 'node'], GONE, '/nodes/fe/body/exit/node', 'fe.b'),
  row('body exit port null', [...FE, 'body', 'exit', 'port'], null, '/nodes/fe/body/exit/port'),
  row('retry body exit missing', [...RT, 'body', 'exit'], GONE, '/nodes/rt/body/exit'),
  row('while body entry port a boolean', [...WH, 'body', 'entry', 'port'], true, '/nodes/wh/body/entry/port'),
  row('nested body entry node missing', [...INNER, 'body', 'entry', 'node'], GONE, '/nodes/wh/body/nodes/inner/body/entry/node'),
  row('nested body node fn a number', [...INNER, 'body', 'nodes', 'a', 'fn'], 5, '/nodes/wh/body/nodes/inner/body/nodes/a/fn'),
  row('body node kind unknown', [...FE, 'body', 'nodes', 'a', 'kind'], 'sorter', '/nodes/fe/body/nodes/a/kind', 'map'),
  row('body node in missing', [...FE, 'body', 'nodes', 'b', 'in'], GONE, '/nodes/fe/body/nodes/b/in', {}),
  row('body node out missing', [...FE, 'body', 'nodes', 'b', 'out'], GONE, '/nodes/fe/body/nodes/b/out', {}),
]);

const edgeRows = (label: string, edgesAt: readonly string[], prefix: string): Row[] => {
  const e0 = [...edgesAt, '0'];
  return [
    row(`${label} edge a number`, e0, 5, `${prefix}/0`),
    row(`${label} edge null`, e0, null, `${prefix}/0`),
    row(`${label} edge a string`, e0, 'a.out->b.in', `${prefix}/0`),
    row(`${label} edge an array`, e0, [], `${prefix}/0`),
    row(`${label} edge a class instance`, e0, new Point(), `${prefix}/0`),
    row(`${label} edge from missing`, [...e0, 'from'], GONE, `${prefix}/0/from`, ref('a', 'out')),
    row(`${label} edge from a string`, [...e0, 'from'], 'a.out', `${prefix}/0/from`),
    row(`${label} edge from null`, [...e0, 'from'], null, `${prefix}/0/from`),
    row(`${label} edge from an array`, [...e0, 'from'], ['a', 'out'], `${prefix}/0/from`),
    row(`${label} edge to missing`, [...e0, 'to'], GONE, `${prefix}/0/to`, ref('b', 'in')),
    row(`${label} edge to a number`, [...e0, 'to'], 5, `${prefix}/0/to`),
    row(`${label} edge to null`, [...e0, 'to'], null, `${prefix}/0/to`),
    row(`${label} edge from.node missing`, [...e0, 'from', 'node'], GONE, `${prefix}/0/from/node`, 'a'),
    row(`${label} edge from.node a number`, [...e0, 'from', 'node'], 5, `${prefix}/0/from/node`),
    row(`${label} edge from.node null`, [...e0, 'from', 'node'], null, `${prefix}/0/from/node`),
    row(`${label} edge from.node an object`, [...e0, 'from', 'node'], {}, `${prefix}/0/from/node`),
    row(`${label} edge from.port missing`, [...e0, 'from', 'port'], GONE, `${prefix}/0/from/port`, 'out'),
    row(`${label} edge from.port a number`, [...e0, 'from', 'port'], 5, `${prefix}/0/from/port`),
    row(`${label} edge from.port null`, [...e0, 'from', 'port'], null, `${prefix}/0/from/port`),
    row(`${label} edge to.node missing`, [...e0, 'to', 'node'], GONE, `${prefix}/0/to/node`, 'b'),
    row(`${label} edge to.node a boolean`, [...e0, 'to', 'node'], true, `${prefix}/0/to/node`),
    row(`${label} edge to.port missing`, [...e0, 'to', 'port'], GONE, `${prefix}/0/to/port`, 'in'),
    row(`${label} edge to.port an array`, [...e0, 'to', 'port'], ['in'], `${prefix}/0/to/port`),
  ];
};

checkRows('GM-2: E_SHAPE outer edges', [
  ...edgeRows('outer', ['edges'], '/edges'),
  row('outer second edge a number', ['edges', '1'], 5, '/edges/1'),
  row('outer second edge to.port missing', ['edges', '1', 'to', 'port'], GONE, '/edges/1/to/port', 'in'),
]);
checkRows('GM-2: E_SHAPE body edges', [
  ...edgeRows('body', [...FE, 'body', 'edges'], '/nodes/fe/body/edges'),
  ...edgeRows('nested body', [...INNER, 'body', 'edges'], '/nodes/wh/body/nodes/inner/body/edges'),
]);

// ---------------------------------------------------------------------------------------------------------------------
// The parse/validate boundary: semantic fields are type-checked when present, never required, never range-checked
// ---------------------------------------------------------------------------------------------------------------------

const SEMANTIC: Array<[string, readonly string[], unknown[]]> = [
  ['budgets.maxIterations', [...FE, 'budgets', 'maxIterations'], [0, -1, 1.5, 1e9, -0]],
  ['budgets.maxDurationMs', [...FE, 'budgets', 'maxDurationMs'], [0, -1, 2.5, 1e12]],
  ['while budgets.maxIterations', [...WH, 'budgets', 'maxIterations'], [0, -7]],
  ['retry budgets.maxDurationMs', [...RT, 'budgets', 'maxDurationMs'], [0, -7]],
  ['foreach concurrency', [...FE, 'concurrency'], [0, -1, 2.5]],
  ['nested foreach concurrency', [...INNER, 'concurrency'], [0, -1, 2.5]],
  ['map concurrency', [...MAP, 'concurrency'], [0, -1, 1.5]],
  ['sink concurrency', [...SNK, 'concurrency'], [0, -1, 1.5]],
  ['retry maxAttempts', [...RT, 'maxAttempts'], [0, -1, 2.5]],
  ['retry backoff.baseMs', [...RT, 'backoff', 'baseMs'], [0, -1, 1.5]],
  ['while condition', [...WH, 'condition'], []],
  ['until condition', [...UN, 'condition'], []],
  ['budgets.maxCostUsd', [...FE, 'budgets', 'maxCostUsd'], [0, -1, 0.25]],
  ['budgets.maxTokens', [...FE, 'budgets', 'maxTokens'], [0, 12]],
];

describe('GM-2: E_SHAPE the parse/validate boundary for semantic fields', () => {
  it.each(SEMANTIC)('GM-2: E_SHAPE semantic field %s: absent and out-of-range are ok, a wrong type, undefined or non-finite number is E_SHAPE', (name, at, outOfRange) => {
    const path = pointer(at);
    expect(accepts(edit(validFlow(), at, GONE)), `${name} absent`).toBe(true);
    for (const value of outOfRange) expect(accepts(edit(validFlow(), at, value)), `${name} = ${String(value)}`).toBe(true);
    // wrong types, a present-but-undefined key, and (numbers only) the non-finite values that are not JSON
    const wrong = at[at.length - 1] === 'condition' ? [5, true, null, {}, [], undefined] : ['10', true, null, {}, [], undefined, Number.NaN, Infinity, -Infinity];
    for (const value of wrong) expectOne(edit(validFlow(), at, value), path, nodeOf(at));
  });

  it('GM-2: E_SHAPE a flow with every semantic field absent parses ok', () => {
    const flow = validFlow();
    for (const [, at] of SEMANTIC) edit(flow, at, GONE);
    edit(flow, [...FE, 'budgets'], {});
    edit(flow, [...WH, 'budgets'], {});
    expect(accepts(flow)).toBe(true);
  });

  it('GM-2: E_SHAPE a flow with every semantic field out of range parses ok', () => {
    const flow = validFlow();
    edit(flow, [...FE, 'budgets'], { maxIterations: 0, maxDurationMs: -1 });
    edit(flow, [...FE, 'concurrency'], 0);
    edit(flow, [...MAP, 'concurrency'], -3);
    edit(flow, [...SNK, 'concurrency'], 1.5);
    edit(flow, [...RT, 'maxAttempts'], -2);
    edit(flow, [...RT, 'backoff', 'baseMs'], -100);
    expect(accepts(flow)).toBe(true);
  });
});

describe('GM-2: E_SHAPE retry backoff and onExhausted', () => {
  const retryRows: Row[] = [
    row('retry maxAttempts a string', [...RT, 'maxAttempts'], '3', '/nodes/rt/maxAttempts', GONE, 0, 5),
    row('retry backoff missing', [...RT, 'backoff'], GONE, '/nodes/rt/backoff', { kind: 'fixed', baseMs: 1 }),
    row('retry backoff present but undefined', [...RT, 'backoff'], undefined, '/nodes/rt/backoff', { kind: 'fixed', baseMs: 1 }),
    row('retry backoff kind present but undefined', [...RT, 'backoff', 'kind'], undefined, '/nodes/rt/backoff/kind', 'fixed'),
    row('retry onExhausted present but undefined', [...RT, 'onExhausted'], undefined, '/nodes/rt/onExhausted', 'fail-run'),
    row('retry backoff a number', [...RT, 'backoff'], 5, '/nodes/rt/backoff'),
    row('retry backoff null', [...RT, 'backoff'], null, '/nodes/rt/backoff'),
    row('retry backoff an array', [...RT, 'backoff'], [], '/nodes/rt/backoff'),
    row('retry backoff a string', [...RT, 'backoff'], 'fixed', '/nodes/rt/backoff'),
    row('retry backoff kind missing', [...RT, 'backoff', 'kind'], GONE, '/nodes/rt/backoff/kind', 'fixed'),
    row('retry backoff kind unknown', [...RT, 'backoff', 'kind'], 'linear', '/nodes/rt/backoff/kind', 'fixed', 'exponential'),
    row('retry backoff kind wrong case', [...RT, 'backoff', 'kind'], 'Fixed', '/nodes/rt/backoff/kind'),
    row('retry backoff kind a number', [...RT, 'backoff', 'kind'], 5, '/nodes/rt/backoff/kind'),
    row('retry backoff kind null', [...RT, 'backoff', 'kind'], null, '/nodes/rt/backoff/kind'),
    row('retry backoff baseMs a string', [...RT, 'backoff', 'baseMs'], '100', '/nodes/rt/backoff/baseMs', GONE, 0, -1),
    row('retry backoff baseMs NaN', [...RT, 'backoff', 'baseMs'], Number.NaN, '/nodes/rt/backoff/baseMs', GONE, 0, -1),
    row('retry backoff baseMs Infinity', [...RT, 'backoff', 'baseMs'], Infinity, '/nodes/rt/backoff/baseMs', 1.5),
    row('retry backoff baseMs present but undefined', [...RT, 'backoff', 'baseMs'], undefined, '/nodes/rt/backoff/baseMs', GONE),
    row('retry onExhausted missing', [...RT, 'onExhausted'], GONE, '/nodes/rt/onExhausted', 'fail-run', 'emit-error'),
    row('retry onExhausted unknown', [...RT, 'onExhausted'], 'ignore', '/nodes/rt/onExhausted', 'fail-run'),
    row('retry onExhausted wrong case', [...RT, 'onExhausted'], 'Fail-Run', '/nodes/rt/onExhausted'),
    row('retry onExhausted a boolean', [...RT, 'onExhausted'], true, '/nodes/rt/onExhausted'),
    row('retry onExhausted null', [...RT, 'onExhausted'], null, '/nodes/rt/onExhausted'),
  ];
  it.each(retryRows)('GM-2: E_SHAPE $name', ({ at, bad, path, good }) => {
    expectOne(edit(validFlow(), at, bad), path, nodeOf(at));
    for (const value of good) expect(accepts(edit(validFlow(), at, value)), `valid ${String(value)}`).toBe(true);
  });
});

describe('GM-2: E_SHAPE budgets', () => {
  const rows: Row[] = [
    row('budgets.maxIterations a string', [...FE, 'budgets', 'maxIterations'], '10', '/nodes/fe/budgets/maxIterations', GONE, 0),
    row('budgets.maxDurationMs a string', [...FE, 'budgets', 'maxDurationMs'], '1000', '/nodes/fe/budgets/maxDurationMs', GONE, -1),
    row('budgets.maxCostUsd a string', [...FE, 'budgets', 'maxCostUsd'], '1.5', '/nodes/fe/budgets/maxCostUsd', GONE, 0.5),
    row('budgets.maxTokens a string', [...FE, 'budgets', 'maxTokens'], '1000', '/nodes/fe/budgets/maxTokens', GONE, 5),
    row('while budgets.maxIterations true', [...WH, 'budgets', 'maxIterations'], true, '/nodes/wh/budgets/maxIterations'),
    row('until budgets.maxDurationMs an object', [...UN, 'budgets', 'maxDurationMs'], {}, '/nodes/un/budgets/maxDurationMs'),
    row('retry budgets.maxTokens null', [...RT, 'budgets', 'maxTokens'], null, '/nodes/rt/budgets/maxTokens'),
    row('nested budgets.maxIterations a string', [...INNER, 'budgets', 'maxIterations'], '1', '/nodes/wh/body/nodes/inner/budgets/maxIterations'),
  ];
  it.each(rows)('GM-2: E_SHAPE $name', ({ at, bad, path, good }) => {
    expectOne(edit(validFlow(), at, bad), path, nodeOf(at));
    for (const value of good) expect(accepts(edit(validFlow(), at, value)), `valid ${String(value)}`).toBe(true);
  });

  it('GM-2: E_SHAPE an empty budgets object is a valid shape (absent budgets are E_MISSING_BUDGET, not E_SHAPE)', () => {
    expect(accepts(edit(validFlow(), [...FE, 'budgets'], {}))).toBe(true);
    expect(accepts(edit(validFlow(), [...FE, 'budgets'], { maxIterations: 1 }))).toBe(true);
    expect(accepts(edit(validFlow(), [...FE, 'budgets'], { maxDurationMs: 1 }))).toBe(true);
  });
});

describe('GM-2: E_SHAPE structure that parseFlow does not police (that is validateFlow)', () => {
  it('GM-2: E_SHAPE accepts an empty flow, empty bodies, dotted ids and dangling references', () => {
    expect(accepts({ version: 1, id: '', name: '', nodes: {}, edges: [] })).toBe(true);
    const emptyBody = { nodes: {}, edges: [], entry: ref('x', 'p'), exit: ref('y', 'q') };
    expect(accepts(edit(validFlow(), [...FE, 'body'], emptyBody))).toBe(true);
    expect(accepts({ version: 1, id: 'f', name: 'f', nodes: { 'a.b': mapNode() }, edges: [edge('nope', 'x', 'missing', 'y')] })).toBe(true);
    expect(accepts(edit(validFlow(), ['edges'], [edge('a', 'out', 'a', 'in'), edge('a', 'out', 'a', 'in')]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Unknown extra keys
// ---------------------------------------------------------------------------------------------------------------------

const escapeKey = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const locate = (flow: Rec, at: readonly string[]): Rec => at.reduce<unknown>((cur, key) => (cur as Rec)[key], flow) as Rec;
// Adds an OWN data property, also for `__proto__` (plain assignment there would change the prototype instead).
const withKey = (flow: Rec, at: readonly string[], key: string, value: unknown): Rec => {
  Object.defineProperty(locate(flow, at), key, { value, enumerable: true, writable: true, configurable: true });
  return flow;
};

// Every object type that has a closed key set (schemas, params and JSON values are not among them), each at several places.
const CLOSED_OBJECTS: Array<[string, readonly string[]]> = [
  ['the flow root', []],
  ['a source', SRC],
  ['a map', MAP],
  ['a sink', SNK],
  ['a foreach frame', FE],
  ['a while frame', WH],
  ['an until frame', UN],
  ['a retry frame', RT],
  ['a nested foreach frame', INNER],
  ['a map in a body', [...FE, 'body', 'nodes', 'a']],
  ['a map in a nested body', [...INNER, 'body', 'nodes', 'b']],
  ['a foreach body', [...FE, 'body']],
  ['a retry body', [...RT, 'body']],
  ['a nested body', [...INNER, 'body']],
  ['foreach budgets', [...FE, 'budgets']],
  ['while budgets', [...WH, 'budgets']],
  ['until budgets', [...UN, 'budgets']],
  ['retry budgets', [...RT, 'budgets']],
  ['nested budgets', [...INNER, 'budgets']],
  ['retry backoff', [...RT, 'backoff']],
  ['an outer edge', ['edges', '0']],
  ['an outer edge source ref', ['edges', '0', 'from']],
  ['an outer edge target ref', ['edges', '1', 'to']],
  ['a body edge', [...FE, 'body', 'edges', '0']],
  ['a body edge source ref', [...FE, 'body', 'edges', '0', 'from']],
  ['a body edge target ref', [...FE, 'body', 'edges', '0', 'to']],
  ['a nested body edge', [...INNER, 'body', 'edges', '0']],
  ['a body entry ref', [...FE, 'body', 'entry']],
  ['a body exit ref', [...RT, 'body', 'exit']],
  ['a nested body entry ref', [...INNER, 'body', 'entry']],
  ['a nested body exit ref', [...INNER, 'body', 'exit']],
];

const UNKNOWN_KEYS = [
  'extra',
  'concurency', // typos of real optional fields
  'maxIteration',
  'maxIterations2',
  'maxCostUSD',
  'maxToken',
  'condtion',
  'maxAttempt',
  'onExhausted2',
  'baseMS',
  'Kind',
  'inferFrom',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'a/b',
  '~',
  '~1',
  '',
];
// The flow root's own words: unknown on every other object, except `nodes`, which a body has too.
const FLOW_WORDS = ['id', 'version', 'name', 'nodes'];
const unknownKeysAt = (at: readonly string[]): string[] => [
  ...UNKNOWN_KEYS,
  ...(at.length === 0 ? [] : FLOW_WORDS.filter((word) => word !== 'nodes' || at.at(-1) !== 'body')),
];

describe('GM-2: E_SHAPE unknown extra keys are rejected on every closed object', () => {
  for (const [name, at] of CLOSED_OBJECTS) {
    for (const key of unknownKeysAt(at)) {
      it(`GM-2: E_SHAPE unknown key ${JSON.stringify(key)} on ${name}`, () => {
        const path = `${pointer(at)}/${escapeKey(key)}`;
        // the error does not depend on what the unknown key holds (the value is never examined)
        for (const value of [1, 'x', null, undefined, { a: [1] }]) expectOne(withKey(validFlow(), at, key, value), path, nodeOf(at));
        // the near-identical valid object without the extra key
        expect(accepts(validFlow()), 'the base flow').toBe(true);
      });
    }
  }

  it('GM-2: E_SHAPE the paths of unknown keys are RFC 6901 escaped', () => {
    expectOne(withKey(validFlow(), [], 'a/b', 1), '/a~1b', undefined);
    expectOne(withKey(validFlow(), [], '~1', 1), '/~01', undefined);
    expectOne(withKey(validFlow(), [], '', 1), '/', undefined);
    expectOne(withKey(validFlow(), [...FE, 'budgets'], '~/', 1), '/nodes/fe/budgets/~0~1', 'fe');
  });

  it('GM-2: E_SHAPE every unknown key of an object is reported, once each, in path order', () => {
    const flow = withKey(withKey(withKey(validFlow(), [], 'zeta', 1), [], 'alpha', 1), [], 'Mu', 1);
    expect(errorsOf(flow).map((e) => [e.code, e.path])).toEqual([
      ['E_SHAPE', '/Mu'],
      ['E_SHAPE', '/alpha'],
      ['E_SHAPE', '/zeta'],
    ]);
  });

  it('GM-2: E_SHAPE an unknown key whose getter throws is still just E_SHAPE at that key', () => {
    const flow = validFlow();
    Object.defineProperty(flow, 'bomb', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expectOne(flow, '/bomb', undefined);
  });

  it('GM-2: E_SHAPE every key an object may have is accepted together', () => {
    const flow = validFlow();
    edit(flow, [...MAP, 'params'], { k: 1 });
    edit(flow, [...SNK, 'params'], [1]);
    edit(flow, [...FE, 'body', 'nodes', 'a', 'params'], null);
    edit(flow, [...FE, 'body', 'nodes', 'a', 'concurrency'], 3);
    edit(flow, [...FE, 'budgets'], budgets());
    expect(accepts(flow)).toBe(true);
    expect(Object.keys(locate(flow, [...FE, 'budgets'])).sort()).toEqual(['maxCostUsd', 'maxDurationMs', 'maxIterations', 'maxTokens']);
  });
});

// Keys of another node kind or frame variant are unknown, in both directions.
describe('GM-2: E_SHAPE keys of another node kind or frame variant are unknown', () => {
  const FRAMES: Array<[string, readonly string[], string, string[]]> = [
    ['foreach', FE, 'fe', ['concurrency']],
    ['while', WH, 'wh', ['condition']],
    ['until', UN, 'un', ['condition']],
    ['retry', RT, 'rt', ['maxAttempts', 'backoff', 'onExhausted']],
  ];
  const VARIANT_KEYS: Array<[string, unknown, unknown]> = [
    ['concurrency', 2, 'two'],
    ['condition', 'c', 3],
    ['maxAttempts', 2, 'two'],
    ['backoff', { kind: 'fixed', baseMs: 1 }, 'fixed'],
    ['onExhausted', 'fail-run', 'ignore'],
  ];

  for (const [frame, at, node, own] of FRAMES) {
    for (const [key, valid, illTyped] of VARIANT_KEYS) {
      if (own.includes(key)) {
        it(`GM-2: E_SHAPE ${key} on a ${frame} frame is accepted (its own field)`, () => {
          expect(accepts(edit(validFlow(), [...at, key], valid))).toBe(true);
          expectOne(edit(validFlow(), [...at, key], illTyped), `${pointer(at)}/${key}`, node);
        });
      } else {
        it(`GM-2: E_SHAPE ${key} on a ${frame} frame is an unknown key`, () => {
          expectOne(withKey(validFlow(), at, key, valid), `${pointer(at)}/${key}`, node);
          expectOne(withKey(validFlow(), at, key, illTyped), `${pointer(at)}/${key}`, node);
          expectOne(withKey(validFlow(), at, key, undefined), `${pointer(at)}/${key}`, node);
        });
      }
    }
  }

  it('GM-2: E_SHAPE condition on a nested foreach frame is an unknown key, concurrency there is accepted', () => {
    expectOne(withKey(validFlow(), INNER, 'condition', 'c'), '/nodes/wh/body/nodes/inner/condition', 'wh.inner');
    expectOne(withKey(validFlow(), INNER, 'onExhausted', 'fail-run'), '/nodes/wh/body/nodes/inner/onExhausted', 'wh.inner');
    expect(accepts(edit(validFlow(), [...INNER, 'concurrency'], 7))).toBe(true);
  });

  it('GM-2: E_SHAPE maxCostUsd and maxTokens stay allowed in the budgets of every frame variant', () => {
    for (const at of [FE, WH, UN, RT, INNER]) {
      expect(accepts(edit(edit(validFlow(), [...at, 'budgets', 'maxCostUsd'], 0.5), [...at, 'budgets', 'maxTokens'], 9))).toBe(true);
    }
  });

  const CROSS: Array<[string, readonly string[], string, unknown]> = [
    ['in on a source', SRC, 'in', { type: 'integer' }],
    ['concurrency on a source', SRC, 'concurrency', 1],
    ['frame on a source', SRC, 'frame', 'foreach'],
    ['body on a source', SRC, 'body', body('src')],
    ['budgets on a source', SRC, 'budgets', budgets()],
    ['condition on a source', SRC, 'condition', 'c'],
    ['maxAttempts on a source', SRC, 'maxAttempts', 1],
    ['frame on a map', MAP, 'frame', 'foreach'],
    ['body on a map', MAP, 'body', body('m')],
    ['budgets on a map', MAP, 'budgets', budgets()],
    ['condition on a map', MAP, 'condition', 'c'],
    ['onExhausted on a map', MAP, 'onExhausted', 'fail-run'],
    ['out on a sink', SNK, 'out', {}],
    ['frame on a sink', SNK, 'frame', 'foreach'],
    ['backoff on a sink', SNK, 'backoff', { kind: 'fixed', baseMs: 1 }],
    ['fn on a foreach frame', FE, 'fn', 'f'],
    ['params on a foreach frame', FE, 'params', { k: 1 }],
    ['fn on a while frame', WH, 'fn', 'f'],
    ['params on an until frame', UN, 'params', null],
    ['params on a retry frame', RT, 'params', []],
    ['fn on a nested frame', INNER, 'fn', 'f'],
    ['frame on a map in a body', [...FE, 'body', 'nodes', 'a'], 'frame', 'while'],
  ];

  it.each(CROSS)('GM-2: E_SHAPE %s is an unknown key', (_name, at, key, value) => {
    expectOne(withKey(validFlow(), at, key, value), `${pointer(at)}/${key}`, nodeOf(at));
  });

  it('GM-2: E_SHAPE a map that becomes a sink keeps its `out`, which is then unknown', () => {
    expectOne(edit(validFlow(), [...MAP, 'kind'], 'sink'), '/nodes/m/out', 'm');
    expectOne(edit(edit(edit(validFlow(), [...SNK, 'kind'], 'source'), [...SNK, 'concurrency'], GONE), [...SNK, 'out'], {}), '/nodes/snk/in', 'snk');
    expectOne(edit(edit(validFlow(), [...SRC, 'kind'], 'sink'), [...SRC, 'in'], {}), '/nodes/src/out', 'src');
    expectOne(edit(edit(validFlow(), [...MAP, 'kind'], 'source'), [...MAP, 'concurrency'], GONE), '/nodes/m/in', 'm');
  });

  it('GM-2: E_SHAPE a frame whose frame variant changes leaves the old variant keys unknown', () => {
    expectOne(edit(validFlow(), [...FE, 'frame'], 'while'), '/nodes/fe/concurrency', 'fe');
    expectOne(edit(validFlow(), [...WH, 'frame'], 'foreach'), '/nodes/wh/condition', 'wh');
    expect(accepts(edit(validFlow(), [...WH, 'frame'], 'until'))).toBe(true);
    const retryAsForeach = errorsOf(edit(validFlow(), [...RT, 'frame'], 'foreach'));
    expect(retryAsForeach.map((e) => [e.path, e.node])).toEqual([
      ['/nodes/rt/backoff', 'rt'],
      ['/nodes/rt/maxAttempts', 'rt'],
      ['/nodes/rt/onExhausted', 'rt'],
    ]);
  });
});

describe('GM-2: E_SHAPE an unresolved variant tolerates the keys of every variant, an unknown key is still reported', () => {
  const allNodeKeys = (): Rec => ({
    fn: 'f',
    params: null,
    in: {},
    out: {},
    concurrency: 1,
    frame: 'foreach',
    body: body('x'),
    budgets: budgets(),
    condition: 'c',
    maxAttempts: 1,
    backoff: { kind: 'fixed', baseMs: 1 },
    onExhausted: 'fail-run',
  });
  const allFrameKeys = (): Rec => ({
    ...frameCommon('x'),
    concurrency: 1,
    condition: 'c',
    maxAttempts: 1,
    backoff: { kind: 'fixed', baseMs: 1 },
    onExhausted: 'fail-run',
  });

  it.each([['an unknown kind', 'sorter'], ['a kind of the wrong type', 5], ['a null kind', null], ['a missing kind', GONE]])(
    'GM-2: E_SHAPE %s: one error at kind, all kinds keys tolerated, an unknown key reported besides',
    (_name, kind) => {
      const node = (): Rec => (kind === GONE ? allNodeKeys() : { kind, ...allNodeKeys() });
      expectOne(edit(validFlow(), SRC, node()), '/nodes/src/kind', 'src');
      const errors = errorsOf(edit(validFlow(), SRC, { ...node(), bogus: 1 }));
      expect(errors.map((e) => [e.path, e.node])).toEqual([
        ['/nodes/src/bogus', 'src'],
        ['/nodes/src/kind', 'src'],
      ]);
    },
  );

  it.each([['an unknown frame', 'loop'], ['a frame of the wrong type', 5], ['a null frame', null], ['a missing frame', GONE]])(
    'GM-2: E_SHAPE %s: one error at frame, all variant keys tolerated, an unknown key reported besides',
    (_name, frame) => {
      const node = (): Rec => (frame === GONE ? allFrameKeys() : { ...allFrameKeys(), frame });
      expectOne(edit(validFlow(), FE, node()), '/nodes/fe/frame', 'fe');
      const errors = errorsOf(edit(validFlow(), FE, { ...node(), bogus: 1 }));
      expect(errors.map((e) => [e.path, e.node])).toEqual([
        ['/nodes/fe/bogus', 'fe'],
        ['/nodes/fe/frame', 'fe'],
      ]);
    },
  );

  it('GM-2: E_SHAPE an unknown backoff kind tolerates baseMs and reports an unknown key besides', () => {
    expectOne(edit(validFlow(), [...RT, 'backoff'], { kind: 'linear', baseMs: 5 }), '/nodes/rt/backoff/kind', 'rt');
    const errors = errorsOf(edit(validFlow(), [...RT, 'backoff'], { kind: 'linear', baseMs: 5, jitter: 1 }));
    expect(errors.map((e) => [e.path, e.node])).toEqual([
      ['/nodes/rt/backoff/jitter', 'rt'],
      ['/nodes/rt/backoff/kind', 'rt'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Schemas: every PortSpec is exactly one well-formed union member
// ---------------------------------------------------------------------------------------------------------------------

type SchemaRow = { name: string; bad: unknown; rel: string; good: readonly unknown[] };
const srow = (name: string, bad: unknown, rel: string, ...good: unknown[]): SchemaRow => ({ name, bad, rel, good });

const VALID_SCHEMAS: Rec[] = [
  {},
  { type: 'null' },
  { type: 'boolean' },
  { type: 'number' },
  { type: 'integer' },
  { type: 'string' },
  { type: 'array', items: {} },
  { type: 'array', items: { type: 'string' } },
  { type: 'object', properties: {} },
  { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false },
  { anyOf: [{ type: 'string' }, { type: 'null' }] },
  { enum: [1, 'a', null, [1], { a: true }] },
];

const OUTSIDE_SUBSET = [
  'pattern', '$ref', 'const', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength',
  'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'patternProperties', 'propertyNames',
  'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'default', 'description', 'title', 'examples', '$schema', '$id', 'definitions',
  '$defs', 'nullable', 'contains', 'prefixItems', 'additionalItems', 'unevaluatedProperties', 'dependentRequired', 'readOnly',
];

const schemaRows = (): SchemaRow[] => {
  const rows: SchemaRow[] = [];
  for (const k of OUTSIDE_SUBSET) {
    rows.push(srow(`keyword ${k} alone`, { [k]: 'x' }, `/${k}`, {}));
    rows.push(srow(`keyword ${k} beside type string`, { type: 'string', [k]: 'x' }, `/${k}`, { type: 'string' }));
  }
  for (const valid of VALID_SCHEMAS) {
    rows.push(srow(`keyword pattern added to ${JSON.stringify(valid)}`, { ...valid, pattern: '^a' }, '/pattern', valid));
    rows.push(srow(`keyword $ref added to ${JSON.stringify(valid)}`, { ...valid, $ref: '#/x' }, '/$ref', valid));
  }
  rows.push(
    // exactly one union member: mixes are one error at the schema itself
    srow('type and enum', { type: 'string', enum: ['a'] }, '', { type: 'string' }, { enum: ['a'] }),
    srow('type and anyOf', { type: 'string', anyOf: [{}] }, '', { type: 'string' }, { anyOf: [{}] }),
    srow('anyOf and enum', { anyOf: [{ type: 'string' }], enum: ['a'] }, '', { anyOf: [{ type: 'string' }] }, { enum: ['a'] }),
    srow('type, anyOf and enum (one error, not three)', { type: 'string', anyOf: [{}], enum: ['a'] }, '', { type: 'string' }),
    srow('array type and enum', { type: 'array', items: {}, enum: [[]] }, '', { type: 'array', items: {} }),
    srow('object type and anyOf', { type: 'object', properties: {}, anyOf: [{}] }, '', { type: 'object', properties: {} }),
    srow('inferFrom and type', { inferFrom: [1], type: 'integer' }, '', { inferFrom: [1] }, { type: 'integer' }),
    srow('inferFrom and enum', { inferFrom: [1], enum: [1] }, '', { inferFrom: [1] }, { enum: [1] }),
    srow('inferFrom and anyOf', { inferFrom: [1], anyOf: [{}] }, '', { inferFrom: [1] }, { anyOf: [{}] }),
    srow('inferFrom beside an unsupported keyword', { inferFrom: [1], pattern: 'a' }, '/pattern', { inferFrom: [1] }),
    // keywords that belong to another member (typeless required/properties/items and friends)
    srow('required without a type', { required: ['a'] }, '/required', {}),
    srow('properties without a type', { properties: {} }, '/properties', {}),
    srow('items without a type', { items: { type: 'string' } }, '/items', {}),
    srow('additionalProperties without a type', { additionalProperties: false }, '/additionalProperties', {}),
    srow('items on a string', { type: 'string', items: {} }, '/items', { type: 'string' }),
    srow('properties on a string', { type: 'string', properties: {} }, '/properties', { type: 'string' }),
    srow('required on a number', { type: 'number', required: [] }, '/required', { type: 'number' }),
    srow('required on an array', { type: 'array', items: {}, required: [] }, '/required', { type: 'array', items: {} }),
    srow('properties on an array', { type: 'array', items: {}, properties: {} }, '/properties', { type: 'array', items: {} }),
    srow('items on an object', { type: 'object', properties: {}, items: {} }, '/items', { type: 'object', properties: {} }),
    srow('additionalProperties on an integer', { type: 'integer', additionalProperties: true }, '/additionalProperties', { type: 'integer' }),
    srow('additionalProperties on an array', { type: 'array', items: {}, additionalProperties: false }, '/additionalProperties', {
      type: 'array',
      items: {},
    }),
    srow('items on an anyOf', { anyOf: [{}], items: {} }, '/items', { anyOf: [{}] }),
    srow('required on an enum', { enum: [1], required: [] }, '/required', { enum: [1] }),
    srow('properties on an enum', { enum: [1], properties: {} }, '/properties', { enum: [1] }),
    srow('a stray key beside an object schema', { type: 'object', properties: {}, extra: 1 }, '/extra', { type: 'object', properties: {} }),
    srow('a stray key beside a primitive', { type: 'string', extra: 1 }, '/extra', { type: 'string' }),
    srow('a stray key on the any-schema', { extra: 1 }, '/extra', {}),
    srow('inferFrom nested in array items', { type: 'array', items: { inferFrom: [1] } }, '/items/inferFrom', { type: 'array', items: {} }),
    srow('inferFrom nested in a property', { type: 'object', properties: { a: { inferFrom: [1] } } }, '/properties/a/inferFrom', {
      type: 'object',
      properties: { a: {} },
    }),
    srow('inferFrom nested in anyOf', { anyOf: [{ inferFrom: [1] }] }, '/anyOf/0/inferFrom', { anyOf: [{}] }),
    // type
    srow('type unknown (date)', { type: 'date' }, '/type', { type: 'string' }),
    srow('type unknown (any)', { type: 'any' }, '/type', {}),
    srow('type unknown (float)', { type: 'float' }, '/type', { type: 'number' }),
    srow('type wrong case', { type: 'String' }, '/type', { type: 'string' }),
    srow('type with a trailing space', { type: 'string ' }, '/type', { type: 'string' }),
    srow('type an array of names', { type: ['string', 'null'] }, '/type', { anyOf: [{ type: 'string' }, { type: 'null' }] }),
    srow('type an empty array', { type: [] }, '/type', {}),
    srow('type a number', { type: 5 }, '/type', { type: 'integer' }),
    srow('type null', { type: null }, '/type', { type: 'null' }),
    srow('type true', { type: true }, '/type', { type: 'boolean' }),
    srow('type an object', { type: {} }, '/type', {}),
    srow('array type misspelled (arrays)', { type: 'arrays', items: {} }, '/type', { type: 'array', items: {} }),
    // array
    srow('array without items', { type: 'array' }, '/items', { type: 'array', items: {} }),
    srow('array with tuple items', { type: 'array', items: [{ type: 'string' }] }, '/items', { type: 'array', items: { type: 'string' } }),
    srow('array with items a number', { type: 'array', items: 5 }, '/items', { type: 'array', items: {} }),
    srow('array with items null', { type: 'array', items: null }, '/items', { type: 'array', items: {} }),
    srow('array with items a string', { type: 'array', items: 'string' }, '/items', { type: 'array', items: {} }),
    srow('array items with an unknown type', { type: 'array', items: { type: 'date' } }, '/items/type', { type: 'array', items: { type: 'string' } }),
    srow('array of arrays, the inner one without items', { type: 'array', items: { type: 'array' } }, '/items/items', {
      type: 'array',
      items: { type: 'array', items: {} },
    }),
    // object
    srow('object without properties', { type: 'object' }, '/properties', { type: 'object', properties: {} }),
    srow('object properties an array', { type: 'object', properties: [] }, '/properties', { type: 'object', properties: {} }),
    srow('object properties a string', { type: 'object', properties: 'a' }, '/properties', { type: 'object', properties: {} }),
    srow('object properties null', { type: 'object', properties: null }, '/properties', { type: 'object', properties: {} }),
    srow('object property a number', { type: 'object', properties: { a: 5 } }, '/properties/a', { type: 'object', properties: { a: {} } }),
    srow('object property null', { type: 'object', properties: { a: null } }, '/properties/a', { type: 'object', properties: { a: {} } }),
    srow('object property an array', { type: 'object', properties: { a: [] } }, '/properties/a', { type: 'object', properties: { a: {} } }),
    srow('object property with an unknown type', { type: 'object', properties: { a: { type: 'date' } } }, '/properties/a/type', {
      type: 'object',
      properties: { a: { type: 'string' } },
    }),
    srow('second property outside the subset', { type: 'object', properties: { a: { type: 'string' }, b: { pattern: 'x' } } }, '/properties/b/pattern', {
      type: 'object',
      properties: { a: { type: 'string' }, b: {} },
    }),
    srow('object property key with a slash', { type: 'object', properties: { 'a/b': { type: 'date' } } }, '/properties/a~1b/type', {
      type: 'object',
      properties: { 'a/b': {} },
    }),
    srow('object property key with a tilde', { type: 'object', properties: { '~': { type: 'date' } } }, '/properties/~0/type'),
    srow('object property key tilde-one', { type: 'object', properties: { '~1': { type: 'date' } } }, '/properties/~01/type'),
    srow('object property key empty', { type: 'object', properties: { '': { type: 'date' } } }, '/properties//type'),
    srow('object properties that look like keywords are fine', { type: 'object', properties: { type: { type: 'date' } } }, '/properties/type/type', {
      type: 'object',
      properties: { type: { type: 'string' }, pattern: {}, $ref: {}, inferFrom: {}, enum: {}, required: {}, items: {} },
    }),
    srow('required a string', { type: 'object', properties: {}, required: 'a' }, '/required', { type: 'object', properties: {}, required: ['a'] }),
    srow('required an object', { type: 'object', properties: {}, required: {} }, '/required', { type: 'object', properties: {}, required: [] }),
    srow('required null', { type: 'object', properties: {}, required: null }, '/required', { type: 'object', properties: {}, required: [] }),
    srow('required holding a number', { type: 'object', properties: {}, required: [1] }, '/required/0', { type: 'object', properties: {}, required: ['1'] }),
    srow('required holding a number second', { type: 'object', properties: {}, required: ['a', 2] }, '/required/1', {
      type: 'object',
      properties: {},
      required: ['a', 'b'],
    }),
    srow('required holding null', { type: 'object', properties: {}, required: [null] }, '/required/0'),
    srow('required holding an array', { type: 'object', properties: {}, required: [['a']] }, '/required/0'),
    srow('required naming an undefined property is fine here', { type: 'object', properties: {}, required: [1, 'zzz'] }, '/required/0', {
      type: 'object',
      properties: {},
      required: ['zzz'],
    }),
    srow('additionalProperties a string', { type: 'object', properties: {}, additionalProperties: 'false' }, '/additionalProperties', {
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    srow('additionalProperties 0', { type: 'object', properties: {}, additionalProperties: 0 }, '/additionalProperties', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    srow('additionalProperties null', { type: 'object', properties: {}, additionalProperties: null }, '/additionalProperties'),
    srow('additionalProperties an empty object', { type: 'object', properties: {}, additionalProperties: {} }, '/additionalProperties'),
    srow('additionalProperties a schema', { type: 'object', properties: {}, additionalProperties: { type: 'string' } }, '/additionalProperties'),
    // anyOf
    srow('anyOf an object', { anyOf: {} }, '/anyOf', { anyOf: [{}] }),
    srow('anyOf a string', { anyOf: 'x' }, '/anyOf', { anyOf: [{}] }),
    srow('anyOf null', { anyOf: null }, '/anyOf', { anyOf: [{}] }),
    srow('anyOf a number', { anyOf: 5 }, '/anyOf'),
    srow('anyOf empty', { anyOf: [] }, '/anyOf', { anyOf: [{}] }),
    srow('anyOf member a number', { anyOf: [5] }, '/anyOf/0', { anyOf: [{}] }),
    srow('anyOf member null second', { anyOf: [{ type: 'string' }, null] }, '/anyOf/1', { anyOf: [{ type: 'string' }, {}] }),
    srow('anyOf member with an unknown type', { anyOf: [{ type: 'string' }, { type: 'date' }] }, '/anyOf/1/type', { anyOf: [{ type: 'string' }, { type: 'null' }] }),
    srow('anyOf nested, member outside the subset', { anyOf: [{ anyOf: [{ pattern: 'x' }] }] }, '/anyOf/0/anyOf/0/pattern', { anyOf: [{ anyOf: [{}] }] }),
    srow('anyOf nested and empty', { anyOf: [{ anyOf: [] }] }, '/anyOf/0/anyOf', { anyOf: [{ anyOf: [{}] }] }),
    srow(
      'deep composite, innermost anyOf member outside the subset',
      { type: 'object', properties: { a: { type: 'array', items: { anyOf: [{ type: 'string' }, { format: 'x' }] } } } },
      '/properties/a/items/anyOf/1/format',
      { type: 'object', properties: { a: { type: 'array', items: { anyOf: [{ type: 'string' }, {}] } } } },
    ),
    // enum
    srow('enum a string', { enum: 'x' }, '/enum', { enum: ['x'] }),
    srow('enum an object', { enum: {} }, '/enum', { enum: [{}] }),
    srow('enum null', { enum: null }, '/enum', { enum: [null] }),
    srow('enum a number', { enum: 5 }, '/enum', { enum: [5] }),
    srow('enum empty', { enum: [] }, '/enum', { enum: [null] }),
    srow('enum member undefined', { enum: [1, undefined] }, '/enum/1', { enum: [1, null] }),
    srow('enum member a function', { enum: [() => 1] }, '/enum/0', { enum: [1] }),
    srow('enum member holding NaN', { enum: [{ a: Number.NaN }] }, '/enum/0/a', { enum: [{ a: 0 }] }),
    srow('enum member an array holding Infinity', { enum: [[1, Infinity]] }, '/enum/0/1', { enum: [[1, 1]] }),
    srow('enum member a Date', { enum: [new Date(0)] }, '/enum/0', { enum: ['1970-01-01T00:00:00.000Z'] }),
    srow('enum object-key escaping', { enum: [{ 'a/b': undefined }] }, '/enum/0/a~1b', { enum: [{ 'a/b': null }] }),
    // inferFrom shape
    srow('inferFrom a string', { inferFrom: 'x' }, '/inferFrom', { inferFrom: [] }),
    srow('inferFrom an object', { inferFrom: {} }, '/inferFrom', { inferFrom: [] }),
    srow('inferFrom null', { inferFrom: null }, '/inferFrom', { inferFrom: [] }),
    srow('inferFrom a number', { inferFrom: 5 }, '/inferFrom', { inferFrom: [5] }),
    srow('inferFrom an array-like', { inferFrom: { length: 1, 0: 1 } }, '/inferFrom', { inferFrom: [1] }),
    srow('inferFrom a Set of samples', { inferFrom: new Set([1]) }, '/inferFrom', { inferFrom: [1] }),
    // keyword names are escaped in the path
    srow('unsupported keyword with a slash', { 'a/b': 1 }, '/a~1b', {}),
    srow('unsupported keyword with a tilde', { '~': 1 }, '/~0', {}),
    srow('unsupported keyword tilde-one', { '~1': 1 }, '/~01', {}),
    srow('unsupported keyword that is empty', { '': 1 }, '/', {}),
    srow('unsupported keyword named like an Object.prototype member', { constructor: 1 }, '/constructor', {}),
    srow('unsupported keyword toString', { toString: 'x' }, '/toString', {}),
    srow('unsupported keyword hasOwnProperty', { hasOwnProperty: 1 }, '/hasOwnProperty', {}),
    // not a schema at all
    srow('schema a number', 5, '', {}),
    srow('schema a string', 'string', '', { type: 'string' }),
    srow('schema null', null, '', {}),
    srow('schema true', true, '', {}),
    srow('schema an empty array', [], '', {}),
    srow('schema an array of schemas', [{ type: 'string' }], '', { type: 'string' }),
    srow('schema a function', () => ({}), ''),
    srow('schema a bigint', 1n, ''),
    srow('schema a symbol', Symbol('s'), ''),
    srow('schema a class instance', new Point(), '', {}),
    srow('schema a Map', new Map(), ''),
  );
  return rows;
};

type Location = { name: string; at: readonly string[]; node: string };
const SCHEMA_LOCATIONS: Location[] = [
  { name: 'a source out', at: [...SRC, 'out'], node: 'src' },
  { name: 'a frame in', at: [...FE, 'in'], node: 'fe' },
  { name: 'a body map in', at: [...FE, 'body', 'nodes', 'a', 'in'], node: 'fe.a' },
  { name: 'a doubly nested body map out', at: [...INNER, 'body', 'nodes', 'b', 'out'], node: 'wh.inner.b' },
];
// Every place a PortSpec can live: source out, map in/out, sink in, frame in/out (all four frames), in bodies and nested bodies.
const ALL_PORTS: Location[] = [
  { name: 'source out', at: [...SRC, 'out'], node: 'src' },
  { name: 'map in', at: [...MAP, 'in'], node: 'm' },
  { name: 'map out', at: [...MAP, 'out'], node: 'm' },
  { name: 'sink in', at: [...SNK, 'in'], node: 'snk' },
  { name: 'foreach in', at: [...FE, 'in'], node: 'fe' },
  { name: 'foreach out', at: [...FE, 'out'], node: 'fe' },
  { name: 'while in', at: [...WH, 'in'], node: 'wh' },
  { name: 'until out', at: [...UN, 'out'], node: 'un' },
  { name: 'retry in', at: [...RT, 'in'], node: 'rt' },
  { name: 'retry out', at: [...RT, 'out'], node: 'rt' },
  { name: 'body map in', at: [...FE, 'body', 'nodes', 'a', 'in'], node: 'fe.a' },
  { name: 'body map out', at: [...RT, 'body', 'nodes', 'b', 'out'], node: 'rt.b' },
  { name: 'nested frame in', at: [...INNER, 'in'], node: 'wh.inner' },
  { name: 'nested frame out', at: [...INNER, 'out'], node: 'wh.inner' },
  { name: 'doubly nested map in', at: [...INNER, 'body', 'nodes', 'a', 'in'], node: 'wh.inner.a' },
];

describe('GM-2: E_SHAPE schemas (exactly one well-formed union member)', () => {
  for (const location of SCHEMA_LOCATIONS) {
    for (const r of schemaRows()) {
      it(`GM-2: E_SHAPE schema ${r.name} at ${location.name}`, () => {
        expectOne(edit(validFlow(), location.at, r.bad), `${pointer(location.at)}${r.rel}`, location.node);
        for (const good of r.good) expect(accepts(edit(validFlow(), location.at, good)), `valid ${JSON.stringify(good)}`).toBe(true);
      });
    }
  }

  for (const location of ALL_PORTS) {
    it(`GM-2: E_SHAPE a $ref schema at ${location.name} is named by the keyword`, () => {
      expectOne(edit(validFlow(), location.at, { $ref: '#/definitions/x' }), `${pointer(location.at)}/$ref`, location.node);
      expectOne(edit(validFlow(), location.at, { type: 'string', pattern: '^a' }), `${pointer(location.at)}/pattern`, location.node);
    });

    it(`GM-2: E_SHAPE a port at ${location.name} that is missing or not an object is named by the port`, () => {
      expectOne(edit(validFlow(), location.at, GONE), pointer(location.at), location.node);
      expectOne(edit(validFlow(), location.at, 5), pointer(location.at), location.node);
      expectOne(edit(validFlow(), location.at, null), pointer(location.at), location.node);
    });

    it(`GM-2: E_SHAPE an unresolvable inferFrom at ${location.name} is named by the inferFrom key`, () => {
      expectOne(edit(validFlow(), location.at, { inferFrom: 'x' }), `${pointer(location.at)}/inferFrom`, location.node);
      expect(accepts(edit(validFlow(), location.at, { inferFrom: [1, 'a'] }))).toBe(true);
    });

    it(`GM-2: E_SHAPE every valid schema kind is accepted at ${location.name}`, () => {
      for (const schema of VALID_SCHEMAS) expect(accepts(edit(validFlow(), location.at, schema)), JSON.stringify(schema)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Non-JSON values in inferFrom samples, enum members and params: reported at their own path
// ---------------------------------------------------------------------------------------------------------------------

const BAD_JSON: Array<[string, () => unknown]> = [
  ['undefined', () => undefined],
  ['a function', () => () => 1],
  ['a symbol', () => Symbol('s')],
  ['a bigint', () => 10n],
  ['NaN', () => Number.NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['a Date', () => new Date(0)],
  ['a Map', () => new Map()],
  ['a Set', () => new Set()],
  ['a class instance', () => new Point()],
  ['a RegExp', () => /x/u],
  ['a boxed number', () => new Number(1)],
  ['a boxed string', () => new String('s')],
  ['a typed array', () => new Uint8Array(2)],
  ['an Error', () => new Error('e')],
  ['a Promise', () => Promise.resolve(1)],
  ['an object with a custom prototype', () => Object.create({ inherited: 1 })],
];

type Carrier = { name: string; place: (v: unknown) => Rec; slot: string; node: string };
const CARRIERS: Carrier[] = [
  {
    name: 'an inferFrom sample',
    place: (v) => edit(validFlow(), [...SRC, 'out'], { inferFrom: [1, 'a', null, v] }),
    slot: '/nodes/src/out/inferFrom/3',
    node: 'src',
  },
  {
    name: 'an inferFrom sample in a body',
    place: (v) => edit(validFlow(), [...FE, 'body', 'nodes', 'a', 'in'], { inferFrom: [1, 'a', null, v] }),
    slot: '/nodes/fe/body/nodes/a/in/inferFrom/3',
    node: 'fe.a',
  },
  {
    name: 'an enum member',
    place: (v) => edit(validFlow(), [...MAP, 'in'], { enum: [1, 'a', null, v] }),
    slot: '/nodes/m/in/enum/3',
    node: 'm',
  },
  { name: 'a params value', place: (v) => edit(validFlow(), [...SRC, 'params'], v), slot: '/nodes/src/params', node: 'src' },
];

const POSITIONS: Array<[string, (v: unknown) => unknown, string]> = [
  ['directly', (v) => v, ''],
  ['in an object', (v) => ({ a: v }), '/a'],
  ['in an array', (v) => [0, v], '/1'],
  ['deeper', (v) => ({ a: [{ b: v }] }), '/a/0/b'],
  ['under a key needing escapes', (v) => ({ 'a/b~': v }), '/a~1b~0'],
];

describe('GM-2: E_SHAPE non-JSON values are reported at their own path', () => {
  for (const carrier of CARRIERS) {
    for (const [where, wrap, suffix] of POSITIONS) {
      for (const [kind, make] of BAD_JSON) {
        it(`GM-2: E_SHAPE ${kind} ${where} as ${carrier.name}`, () => {
          expectOne(carrier.place(wrap(make())), `${carrier.slot}${suffix}`, carrier.node);
        });
      }

      it(`GM-2: E_SHAPE valid JSON ${where} as ${carrier.name} is accepted`, () => {
        const good = [null, true, 0, -0, 1.5, 1e300, '', 'é', [], {}, [[]], { k: [{ z: null }] }];
        for (const value of good) expect(accepts(carrier.place(wrap(value))), JSON.stringify(value)).toBe(true);
      });
    }

    it(`GM-2: E_SHAPE a sparse array as ${carrier.name} is reported at the hole`, () => {
      const sparse: unknown[] = new Array(3);
      sparse[0] = 1;
      sparse[2] = 3;
      expectOne(carrier.place(sparse), `${carrier.slot}/1`, carrier.node);
      expectOne(carrier.place({ a: sparse }), `${carrier.slot}/a/1`, carrier.node);
    });
  }

  it('GM-2: E_SHAPE a sparse inferFrom array or enum is reported at the hole', () => {
    const holey = (): unknown[] => {
      const a: unknown[] = new Array(3);
      a[0] = 1;
      a[2] = 3;
      return a;
    };
    expectOne(edit(validFlow(), [...SRC, 'out'], { inferFrom: holey() }), '/nodes/src/out/inferFrom/1', 'src');
    expectOne(edit(validFlow(), [...SRC, 'out'], { enum: holey() }), '/nodes/src/out/enum/1', 'src');
  });

  it('GM-2: E_SHAPE a sample deep in the sample set is named by its index', () => {
    const samples: unknown[] = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    samples[41] = { id: 41, tags: ['x', Symbol('s')] };
    expectOne(edit(validFlow(), [...SRC, 'out'], { inferFrom: samples }), '/nodes/src/out/inferFrom/41/tags/1', 'src');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// JSON Pointer escaping of the path, raw ids in `node`
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE paths are RFC 6901 pointers (~ is ~0, / is ~1, the root is the empty string)', () => {
  const ids: Array<[string, string]> = [
    ['a/b', 'a~1b'],
    ['a~b', 'a~0b'],
    ['~1', '~01'],
    ['~0', '~00'],
    ['/', '~1'],
    ['~', '~0'],
    ['~/', '~0~1'],
    ['', ''],
    ['a.b', 'a.b'],
    ['é', 'é'],
    ['a b', 'a b'],
    ['%2F', '%2F'],
    ['"q"', '"q"'],
    ['back\\slash', 'back\\slash'],
    ['line\nbreak', 'line\nbreak'],
    ['0', '0'],
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
  ];

  it.each(ids)('GM-2: E_SHAPE node id %j is %j in the path and raw in `node`', (id, segment) => {
    const flow = { version: 1, id: 'f', name: 'f', nodes: { [id]: { kind: 'nope' } }, edges: [] };
    expectOne(flow, `/nodes/${segment}/kind`, id);
    const good = { ...flow, nodes: { [id]: mapNode() } };
    expect(accepts(good)).toBe(true);
  });

  it('GM-2: E_SHAPE escaped frame and body-node ids give an escaped path and a dotted raw `node`', () => {
    const frame = (inner: Rec): Rec => ({
      kind: 'frame',
      frame: 'foreach',
      concurrency: 1,
      budgets: budgets(),
      in: {},
      out: {},
      body: { nodes: { 'p~q': inner }, edges: [], entry: ref('x/y.p~q', 'in'), exit: ref('x/y.p~q', 'out') },
    });
    const flow = (fn: unknown): Rec => ({
      version: 1,
      id: 'f',
      name: 'f',
      nodes: { 'x/y': frame({ kind: 'map', fn, in: {}, out: {} }) },
      edges: [],
    });
    expectOne(flow(5), '/nodes/x~1y/body/nodes/p~0q/fn', 'x/y.p~q');
    expect(accepts(flow('f'))).toBe(true);
  });

  it('GM-2: E_SHAPE keys inside inferFrom samples are escaped in the path', () => {
    expectOne(
      edit(validFlow(), [...SRC, 'out'], { inferFrom: [{ 'a/b': undefined }] }),
      '/nodes/src/out/inferFrom/0/a~1b',
      'src',
    );
    expectOne(
      edit(validFlow(), [...SRC, 'out'], { inferFrom: [{ '~': { '/': () => 1 } }] }),
      '/nodes/src/out/inferFrom/0/~0/~1',
      'src',
    );
  });

  it('GM-2: E_SHAPE root errors have the empty-string path and no node property', () => {
    expectOne(null, '', undefined);
    expectOne(edit(validFlow(), ['version'], 2), '/version', undefined);
    expectOne(edit(validFlow(), ['edges', '0', 'to', 'port'], GONE), '/edges/0/to/port', undefined);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The `node` field: the scoped id of the nearest enclosing node
// ---------------------------------------------------------------------------------------------------------------------

describe('GM-2: E_SHAPE the node field is the scoped id of the enclosing node', () => {
  it('GM-2: E_SHAPE errors under nested bodies carry frame.inner.node', () => {
    expectOne(edit(validFlow(), [...INNER, 'body', 'nodes', 'b', 'fn'], 5), '/nodes/wh/body/nodes/inner/body/nodes/b/fn', 'wh.inner.b');
    expectOne(edit(validFlow(), [...INNER, 'budgets', 'maxIterations'], 'x'), '/nodes/wh/body/nodes/inner/budgets/maxIterations', 'wh.inner');
    expectOne(edit(validFlow(), [...WH, 'body', 'nodes', 'a', 'fn'], 5), '/nodes/wh/body/nodes/a/fn', 'wh.a');
  });

  it('GM-2: E_SHAPE errors in a frame body entry, exit and edges name the frame', () => {
    expectOne(edit(validFlow(), [...FE, 'body', 'entry', 'port'], GONE), '/nodes/fe/body/entry/port', 'fe');
    expectOne(edit(validFlow(), [...FE, 'body', 'exit', 'node'], 5), '/nodes/fe/body/exit/node', 'fe');
    expectOne(edit(validFlow(), [...FE, 'body', 'edges', '0', 'to'], 5), '/nodes/fe/body/edges/0/to', 'fe');
    expectOne(edit(validFlow(), [...FE, 'body', 'nodes'], 5), '/nodes/fe/body/nodes', 'fe');
  });

  it('GM-2: E_SHAPE errors on the nodes record or the edges list name no node', () => {
    expectOne(edit(validFlow(), ['nodes'], 5), '/nodes', undefined);
    expectOne(edit(validFlow(), ['edges', '0'], 5), '/edges/0', undefined);
  });
});
