import { inferSchema } from './schema.js';
import type { Flow, JsonValue, ParseResult, ValidationError } from './types.js';

/**
 * parseFlow: the structural parse. It checks SHAPE and the JSON TYPES of every field that is present, builds a FRESH Flow
 * (nothing is shared with the input, the input is only read) and resolves every PortSpec `{ inferFrom }` through
 * inferSchema, so the result never contains `inferFrom`. Anything it cannot accept is E_SHAPE at an RFC 6901 pointer
 * into the INPUT (root = ''); all errors are collected, unique per path, sorted by path in plain UTF-16 order.
 * `node` is the scoped id (`frame.inner.x`, raw, unescaped) of the nearest enclosing node; root-level and `edges`
 * errors have no `node` property.
 *
 * SEMANTIC FIELDS: type-checked when PRESENT (a wrong JSON type, `undefined` or a non-finite number is E_SHAPE at the
 * field), never required and never range-checked here; absence or an out-of-range value passes through for validateFlow
 * (T13-T16: E_MISSING_BUDGET, E_MISSING_EXIT, E_BAD_LIMIT), which therefore reads them defensively. The exact list:
 *   budgets.maxIterations, budgets.maxDurationMs, budgets.maxCostUsd, budgets.maxTokens   (number, finite)
 *   concurrency on map, sink and foreach                                                  (number, finite)
 *   condition on while/until                                                              (string)
 *   maxAttempts on retry, backoff.baseMs on retry                                         (number, finite)
 * Everything else is STRUCTURAL and its absence is E_SHAPE (reported at the path the field would have): version (=== 1),
 * id, name, nodes, edges; per node `kind`, `fn` (source/map/sink), `in`/`out` (the ports the kind has), `frame`, `body`,
 * `budgets` (an object, possibly empty); per body nodes, edges, entry, exit; per PortRef node and port (strings); per
 * retry `backoff` (an object with a `kind` literal) and `onExhausted`. `params` is optional JSON.
 *
 * CLOSED KEY SETS (an object may hold these keys and no others):
 *   flow:      version id name nodes edges            edge:    from to              PortRef: node port
 *   body:      nodes edges entry exit                 budgets: maxIterations maxDurationMs maxCostUsd maxTokens
 *   backoff:   kind baseMs
 *   source:    kind fn params out                     map:     kind fn params in out concurrency
 *   sink:      kind fn params in concurrency
 *   frames:    kind frame body budgets in out, plus foreach: concurrency; while/until: condition;
 *              retry: maxAttempts backoff onExhausted
 * UNKNOWN KEYS are E_SHAPE at `<object path>/<key>`, collected beside every other error; their value is never examined.
 * That includes keys of another node kind or frame variant. While the variant is unresolved (node `kind` or `frame`
 * missing or unknown) the keys of ALL kinds (resp. all frame variants) are tolerated so the single error stays at
 * `kind` / `frame`; an unresolved `kind` also leaves the node's other fields unexamined, an unresolved `frame` still
 * checks the common ones (body, budgets, in, out). Schemas follow their own rule: exactly ONE union member of type,
 * anyOf, enum, inferFrom (inferFrom only directly at a port); a mix is one error at the schema, any other key that does
 * not belong to the member is an unsupported keyword at that key, `array` needs `items`, `object` needs `properties`,
 * `required` is an array of strings, `additionalProperties` a boolean, anyOf and enum are non-empty, enum members,
 * inferFrom samples and `params` are JSON (plain objects incl. null-prototype, finite numbers, no undefined, functions,
 * symbols, bigint, Date, Map, class instances, sparse arrays).
 *
 * PLAIN OBJECT: an object whose prototype is null or whose prototype's own prototype is null. That is `{}`, a
 * null-prototype object and (so a plain object of another realm is accepted too) `Object.create(Object.create(null))`;
 * a class instance, Map, Date, or an object whose prototype is an ordinary object is not plain.
 *
 * ROBUSTNESS: iterative with an explicit task stack (nesting 20,000 deep and 100,000-sample inferFrom arrays are fine),
 * linear in the size of the input as EXPANDED, and BOUNDED in time and memory for JSON DATA (what JSON.parse produces,
 * and plain data built the same way: no getters, Proxies or hidden keys), however large, deep or shared (DAG) it is:
 *   MAX_WORK = 5,000,000: every array element and object entry read, every container task and every length read counts
 *     one (an array whose `length` alone would exceed what is left is rejected before it is read, so a sparse array of
 *     length 1e8 or 2^32-1, a Proxy claiming a huge `length`, or a shared (DAG) structure that expands exponentially
 *     cost almost nothing). What is KEPT counts too: each recorded error costs its path, message and node characters
 *     beyond the first 256, so an error at every level of a deep input or under a huge key cannot grow without limit.
 *     Past the limit parsing stops and the result carries exactly one more error, at '', 'input too large'.
 *   MAX_ERRORS = 250,000: the 250,001st distinct error is not recorded; parsing stops and the result carries exactly
 *     one more error, at '', 'too many errors'. The first 250,000 found stay, sorted as usual. They are found in
 *     DOCUMENT order (object entries and array elements are visited as they appear), so the document's first errors win.
 * The first limit reached is the one reported; reaching either is never ok:true. The limits are not exported (the tests
 * probe them from either side). OUTSIDE the guarantee: a getter or Proxy trap that never returns or is slow, and hidden
 * key blobs (many non-enumerable or symbol keys, a Proxy `ownKeys` listing millions of names) cost time that is not
 * counted; parseFlow still never throws on them.
 * A cycle is E_SHAPE at the reference that closes it. Only own enumerable string keys are read, each property exactly
 * once (`__proto__` and `constructor` are ordinary keys, nothing is written through a prototype; non-enumerable and
 * inherited keys do not exist for this parser, and the value of an unknown key is not read), so a getter that changes
 * its answer cannot make an invalid flow pass. Getters and Proxy traps that throw, revoked proxies, unreadable
 * prototypes and an array whose `length` is not a non-negative integer become E_SHAPE at the path being read;
 * parseFlow never throws. Messages are constants (untrusted values are never stringified).
 */

type Rec = Record<string, unknown>;
type Out = Rec | unknown[];
type Kind = 'array' | 'object' | 'other';
type Fields = Map<string, unknown>;

type Task =
  | { k: 'json'; v: object; out: Out; path: string; node: string | undefined }
  | { k: 'schema'; v: object; out: Rec; path: string; node: string | undefined; port: boolean }
  | { k: 'nodes'; v: object; out: Rec; path: string; node: string | undefined }
  | { k: 'node'; v: object; out: Rec; path: string; node: string }
  | { k: 'exit'; v: object }
  | { k: 'then'; run: () => void };

type Ctx = { errors: ValidationError[]; seen: Set<string>; fails: number; stack: Task[]; active: Set<object>; work: number; halt: string | undefined };
// An object under parse: its known fields (read once), where it lives, and the fresh copy being built.
type At = { c: Ctx; f: Fields; path: string; node: string | undefined; out: Rec };

const MAX_WORK = 5_000_000;
const MAX_ERRORS = 250_000;
const FREE_TEXT = 256; // characters of one error (path, message, node) that cost nothing; the rest counts as work
const WORK_LIMIT = `input too large to parse (work limit ${MAX_WORK})`;
const ERROR_LIMIT = `too many errors (limit ${MAX_ERRORS}); remaining problems not reported`;

const BAD = Symbol('unreadable'); // stands for a value whose read threw (already reported); it fails every type check

const only = (...keys: string[]): ReadonlySet<string> => new Set(keys);
const ROOT_KEYS = only('version', 'id', 'name', 'nodes', 'edges');
const EDGE_KEYS = only('from', 'to');
const REF_KEYS = only('node', 'port');
const BODY_KEYS = only('nodes', 'edges', 'entry', 'exit');
const BUDGET_KEYS = only('maxIterations', 'maxDurationMs', 'maxCostUsd', 'maxTokens');
const BACKOFF_KEYS = only('kind', 'baseMs');
const PLAIN_KEYS = {
  source: only('kind', 'fn', 'params', 'out'),
  map: only('kind', 'fn', 'params', 'in', 'out', 'concurrency'),
  sink: only('kind', 'fn', 'params', 'in', 'concurrency'),
};
const FRAME_COMMON = ['kind', 'frame', 'body', 'budgets', 'in', 'out'];
const FRAME_KEYS = {
  foreach: only(...FRAME_COMMON, 'concurrency'),
  while: only(...FRAME_COMMON, 'condition'),
  until: only(...FRAME_COMMON, 'condition'),
  retry: only(...FRAME_COMMON, 'maxAttempts', 'backoff', 'onExhausted'),
  all: only(...FRAME_COMMON, 'concurrency', 'condition', 'maxAttempts', 'backoff', 'onExhausted'),
};
const NODE_KEYS = only('fn', 'params', 'concurrency', ...FRAME_KEYS.all);
const SCHEMA_KEYS = only('type', 'anyOf', 'enum', 'inferFrom', 'items', 'properties', 'required', 'additionalProperties');
const PRIMITIVES = ['null', 'boolean', 'number', 'integer', 'string'];
const NONE = only();
const ANY_OF = only('anyOf');
const ENUM = only('enum');
const INFER_FROM = only('inferFrom');
const PRIMITIVE_KEYS = only('type');
const ARRAY_KEYS = only('type', 'items');
const OBJECT_KEYS = only('type', 'properties', 'required', 'additionalProperties');
const TYPED_KEYS = only('type', 'items', 'properties', 'required', 'additionalProperties'); // the type is unresolved

const isString = (v: unknown): boolean => typeof v === 'string';
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): boolean => typeof v === 'boolean';
const oneOf =
  (...words: string[]) =>
  (v: unknown): boolean =>
    typeof v === 'string' && words.includes(v);

// RFC 6901: `~` is `~0` and `/` is `~1`.
const esc = (key: string): string => (key.includes('~') || key.includes('/') ? key.replace(/~/g, '~0').replace(/\//g, '~1') : key);

// The first limit reached wins; parsing stops and the reason becomes the one extra error at ''.
const stop = (c: Ctx, reason: string): void => {
  c.halt ??= reason;
};
const tick = (c: Ctx, units = 1): void => {
  c.work += units;
  if (c.work > MAX_WORK) stop(c, WORK_LIMIT);
};

const fail = (c: Ctx, path: string, node: string | undefined, message: string): void => {
  if (c.halt !== undefined) return;
  tick(c, Math.max(0, path.length + message.length + (node?.length ?? 0) - FREE_TEXT)); // what is kept is work too
  if (c.halt !== undefined) return;
  c.fails++;
  if (c.seen.has(path)) return; // every error is E_SHAPE, so (code, path) is unique exactly when the path is
  if (c.errors.length >= MAX_ERRORS) return stop(c, ERROR_LIMIT);
  c.seen.add(path);
  c.errors.push(node === undefined ? { code: 'E_SHAPE', message, path } : { code: 'E_SHAPE', message, path, node });
};
const missing = (at: At, key: string): void => fail(at.c, `${at.path}/${key}`, at.node, 'missing field');

// Plain object (null prototype included), array, or anything else (primitives, functions, class instances, Map, Date,
// revoked or hostile proxies: reading the prototype may throw).
const kindOf = (v: unknown): Kind => {
  if (typeof v !== 'object' || v === null) return 'other';
  try {
    if (Array.isArray(v)) return 'array';
    const proto: object | null = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null ? 'object' : 'other';
  } catch {
    return 'other';
  }
};

// A value to descend into: the wanted kind, and not one of the objects currently being parsed (a cycle).
const enter = (c: Ctx, v: unknown, path: string, node: string | undefined, want: 'array' | 'object'): v is object => {
  if (kindOf(v) !== want) fail(c, path, node, want === 'array' ? 'expected an array' : 'expected an object');
  else if (c.active.has(v as object)) fail(c, path, node, 'cyclic structure');
  else return true;
  return false;
};

// Assigns an OWN property; `__proto__` would otherwise change the prototype.
const put = (to: Out, key: string | number, value: unknown): void => {
  if (key === '__proto__') Object.defineProperty(to, key, { value, enumerable: true, writable: true, configurable: true });
  else (to as Rec)[key] = value;
};

const read = (c: Ctx, o: object, key: string | number, path: string, node: string | undefined): unknown => {
  tick(c);
  try {
    return Reflect.get(o, key);
  } catch {
    fail(c, `${path}/${esc(String(key))}`, node, 'cannot read');
    return BAD;
  }
};

const keysOf = (c: Ctx, o: object, path: string, node: string | undefined): string[] | undefined => {
  try {
    return Object.keys(o);
  } catch {
    fail(c, path, node, 'cannot read the keys');
    return undefined;
  }
};

// The elements of an array, each read once. A hole reads as `undefined`, which the caller rejects like any other value.
const elements = (c: Ctx, a: object, path: string, node: string | undefined): unknown[] | undefined => {
  const n = read(c, a, 'length', path, node);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return void fail(c, `${path}/length`, node, 'array length must be a non-negative integer'); // the same path as a failed read
  if (n > MAX_WORK - c.work) return void stop(c, WORK_LIMIT); // each element is counted as it is read: refuse before reading any
  const els: unknown[] = [];
  for (let i = 0; i < n; i++) els.push(read(c, a, i, path, node));
  return els;
};

// Reads the keys of `o` once: keys outside `universe` are unknown (reported, never read), the others are read once.
const fieldsOf = (c: Ctx, o: object, path: string, node: string | undefined, universe: ReadonlySet<string>): Fields | undefined => {
  const keys = keysOf(c, o, path, node);
  if (keys === undefined) return undefined;
  const fields: Fields = new Map();
  for (const key of keys) {
    if (universe.has(key)) fields.set(key, read(c, o, key, path, node));
    else fail(c, `${path}/${esc(key)}`, node, 'unknown key');
  }
  return fields;
};

// Keys that are known but do not belong to this variant are unknown too.
const restrict = (c: Ctx, f: Fields, allowed: ReadonlySet<string>, path: string, node: string | undefined): void => {
  for (const key of f.keys()) if (!allowed.has(key)) fail(c, `${path}/${esc(key)}`, node, 'unknown key');
};

// A closed object that is parsed on the spot (shallow: no stack needed), with a fresh copy stored at `to[key]`.
const open = (c: Ctx, v: unknown, path: string, node: string | undefined, universe: ReadonlySet<string>, to: Out, key: string | number): At | undefined => {
  if (kindOf(v) !== 'object') return void fail(c, path, node, 'expected an object');
  const f = fieldsOf(c, v as object, path, node, universe);
  if (f === undefined) return undefined;
  const out: Rec = {};
  put(to, key, out);
  return { c, f, path, node, out };
};
const sub = (at: At, key: string, universe: ReadonlySet<string>): At | undefined =>
  at.f.has(key) ? open(at.c, at.f.get(key), `${at.path}/${key}`, at.node, universe, at.out, key) : void missing(at, key);

// A field of a fixed type: copied when it is right, E_SHAPE when it is wrong (or, if required, absent).
const take = (at: At, key: string, required: boolean, ok: (v: unknown) => boolean, what: string): void => {
  if (!at.f.has(key)) {
    if (required) missing(at, key);
    return;
  }
  const v = at.f.get(key);
  if (ok(v)) at.out[key] = v;
  else fail(at.c, `${at.path}/${key}`, at.node, `expected ${what}`);
};
const takeRef = (at: At, key: string): void => {
  const ref = sub(at, key, REF_KEYS);
  if (ref === undefined) return;
  take(ref, 'node', true, isString, 'a string');
  take(ref, 'port', true, isString, 'a string');
};

// ---------------------------------------------------------------------------------------------------------------------
// Placing a value: the check happens here, the work is a task. A fresh container is stored in `to` at once.
// ---------------------------------------------------------------------------------------------------------------------

const placeJson = (c: Ctx, to: Out, key: string | number, v: unknown, path: string, node: string | undefined): void => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || isCount(v)) return put(to, key, v);
  const kind = kindOf(v);
  if (kind === 'other') fail(c, path, node, 'not a JSON value');
  else if (c.active.has(v as object)) fail(c, path, node, 'cyclic structure');
  else {
    const out: Out = kind === 'array' ? [] : {};
    put(to, key, out);
    c.stack.push({ k: 'json', v: v as object, out, path, node });
  }
};

const placeSchema = (c: Ctx, to: Out, key: string | number, v: unknown, path: string, node: string | undefined, port: boolean): void => {
  if (!enter(c, v, path, node, 'object')) return;
  const out: Rec = {};
  put(to, key, out);
  c.stack.push({ k: 'schema', v, out, path, node, port });
};

const placeNode = (c: Ctx, to: Rec, key: string, v: unknown, path: string, id: string): void => {
  if (!enter(c, v, path, id, 'object')) return;
  const out: Rec = {};
  put(to, key, out);
  c.stack.push({ k: 'node', v, out, path, node: id });
};

const takePort = (at: At, key: string): void => {
  if (at.f.has(key)) placeSchema(at.c, at.out, key, at.f.get(key), `${at.path}/${key}`, at.node, true);
  else missing(at, key);
};

// ---------------------------------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------------------------------

const begin = (c: Ctx, v: object): void => {
  c.active.add(v);
  c.stack.push({ k: 'exit', v });
};

// The stack pops last-in-first-out: the tasks pushed since `mark` are turned around so that they run in document order,
// which is also the order the errors are found in (and kept in, when the error limit cuts them off).
const inOrder = (c: Ctx, mark: number): void => {
  for (const t of c.stack.splice(mark).reverse()) c.stack.push(t);
};

const runJson = (c: Ctx, { v, out, path, node }: Extract<Task, { k: 'json' }>): void => {
  begin(c, v);
  const mark = c.stack.length;
  if (Array.isArray(out)) {
    const els = elements(c, v, path, node);
    els?.forEach((el, i) => placeJson(c, out, i, el, `${path}/${i}`, node));
  } else for (const key of keysOf(c, v, path, node) ?? []) placeJson(c, out, key, read(c, v, key, path, node), `${path}/${esc(key)}`, node);
  inOrder(c, mark);
};

// An array that holds schemas, JSON or names, tracked as an ancestor, with a fresh list to copy it into.
const listOf = (at: At, key: string): { els: unknown[]; list: unknown[]; path: string } | undefined => {
  const path = `${at.path}/${key}`;
  const v = at.f.get(key);
  if (!enter(at.c, v, path, at.node, 'array')) return undefined;
  const els = elements(at.c, v, path, at.node);
  if (els === undefined) return undefined;
  begin(at.c, v);
  return { els, list: [], path };
};

const anyOfSchema = (at: At): void => {
  const l = listOf(at, 'anyOf');
  if (l === undefined) return;
  put(at.out, 'anyOf', l.list);
  if (l.els.length === 0) fail(at.c, l.path, at.node, 'anyOf must not be empty');
  const mark = at.c.stack.length;
  l.els.forEach((el, i) => placeSchema(at.c, l.list, i, el, `${l.path}/${i}`, at.node, false));
  inOrder(at.c, mark);
};

const enumSchema = (at: At): void => {
  const l = listOf(at, 'enum');
  if (l === undefined) return;
  put(at.out, 'enum', l.list);
  if (l.els.length === 0) fail(at.c, l.path, at.node, 'enum must not be empty');
  const mark = at.c.stack.length;
  l.els.forEach((el, i) => placeJson(at.c, l.list, i, el, `${l.path}/${i}`, at.node));
  inOrder(at.c, mark);
};

// The samples are validated as JSON first (their tasks run before `then`); only a clean set is inferred.
const inferFromSchema = (at: At): void => {
  const { c, out } = at;
  const before = c.fails;
  const l = listOf(at, 'inferFrom');
  if (l === undefined) return;
  c.stack.push({
    k: 'then',
    run: () => {
      if (c.fails === before) Object.assign(out, inferSchema(l.list as JsonValue[]));
    },
  });
  const mark = c.stack.length;
  l.els.forEach((el, i) => placeJson(c, l.list, i, el, `${l.path}/${i}`, at.node));
  inOrder(c, mark);
};

const objectSchema = (at: At): void => {
  const { c, f, path, node, out } = at;
  if (!f.has('properties')) missing(at, 'properties');
  else {
    const p = `${path}/properties`;
    const record = f.get('properties');
    const keys = enter(c, record, p, node, 'object') ? keysOf(c, record, p, node) : undefined;
    if (keys !== undefined) {
      const props: Rec = {};
      put(out, 'properties', props);
      const mark = c.stack.length;
      for (const key of keys) placeSchema(c, props, key, read(c, record as object, key, p, node), `${p}/${esc(key)}`, node, false);
      inOrder(c, mark);
    }
  }
  if (f.has('required')) {
    const l = listOf(at, 'required');
    if (l !== undefined) put(out, 'required', l.list);
    l?.els.forEach((el, i) => (typeof el === 'string' ? l.list.push(el) : fail(c, `${l.path}/${i}`, node, 'expected a string')));
  }
  take(at, 'additionalProperties', false, isBoolean, 'a boolean');
};

const typedSchema = (at: At): void => {
  const { c, f, path, node, out } = at;
  const type = f.get('type');
  const keys =
    type === 'array' ? ARRAY_KEYS : type === 'object' ? OBJECT_KEYS : typeof type === 'string' && PRIMITIVES.includes(type) ? PRIMITIVE_KEYS : TYPED_KEYS;
  restrict(c, f, keys, path, node);
  if (keys === TYPED_KEYS) return fail(c, `${path}/type`, node, 'unsupported type');
  out['type'] = type;
  if (type === 'object') objectSchema(at);
  else if (type === 'array') {
    if (f.has('items')) placeSchema(c, out, 'items', f.get('items'), `${path}/items`, node, false);
    else missing(at, 'items');
  }
};

const runSchema = (c: Ctx, { v, out, path, node, port }: Extract<Task, { k: 'schema' }>): void => {
  const f = fieldsOf(c, v, path, node, SCHEMA_KEYS);
  if (f === undefined) return;
  begin(c, v);
  const at: At = { c, f, path, node, out };
  const members = ['type', 'anyOf', 'enum', 'inferFrom'].filter((m) => f.has(m) && (port || m !== 'inferFrom'));
  const [member] = members;
  if (members.length > 1) fail(c, path, node, 'a schema is exactly one of type, anyOf, enum, inferFrom');
  else if (member === undefined) restrict(c, f, NONE, path, node);
  else if (member === 'type') typedSchema(at);
  else {
    restrict(c, f, member === 'anyOf' ? ANY_OF : member === 'enum' ? ENUM : INFER_FROM, path, node);
    if (member === 'anyOf') anyOfSchema(at);
    else if (member === 'enum') enumSchema(at);
    else inferFromSchema(at);
  }
};

const takeNodes = (at: At): void => {
  const { c, f, path, node } = at;
  const p = `${path}/nodes`;
  if (!f.has('nodes')) return missing(at, 'nodes');
  const v = f.get('nodes');
  if (!enter(c, v, p, node, 'object')) return;
  const out: Rec = {};
  put(at.out, 'nodes', out);
  c.stack.push({ k: 'nodes', v, out, path: p, node });
};

const runNodes = (c: Ctx, { v, out, path, node }: Extract<Task, { k: 'nodes' }>): void => {
  const keys = keysOf(c, v, path, node);
  if (keys === undefined) return;
  begin(c, v);
  const mark = c.stack.length;
  for (const key of keys) {
    const id = node === undefined ? key : `${node}.${key}`;
    placeNode(c, out, key, read(c, v, key, path, id), `${path}/${esc(key)}`, id);
  }
  inOrder(c, mark);
};

const takeEdges = (at: At): void => {
  const { c, f, path, node } = at;
  const p = `${path}/edges`;
  if (!f.has('edges')) return missing(at, 'edges');
  const v = f.get('edges');
  if (kindOf(v) !== 'array') return fail(c, p, node, 'expected an array');
  const els = elements(c, v as object, p, node);
  if (els === undefined) return;
  const list: unknown[] = [];
  put(at.out, 'edges', list);
  els.forEach((el, i) => {
    const edge = open(c, el, `${p}/${i}`, node, EDGE_KEYS, list, i);
    if (edge === undefined) return;
    takeRef(edge, 'from');
    takeRef(edge, 'to');
  });
};

const takeFrame = (at: At): void => {
  const { f } = at;
  const frame = f.get('frame');
  const variant = frame === 'foreach' || frame === 'while' || frame === 'until' || frame === 'retry' ? frame : 'all';
  restrict(at.c, f, FRAME_KEYS[variant], at.path, at.node);
  take(at, 'frame', true, oneOf('foreach', 'while', 'until', 'retry'), 'one of foreach, while, until, retry');
  const body = sub(at, 'body', BODY_KEYS);
  if (body !== undefined) {
    takeNodes(body);
    takeEdges(body);
    takeRef(body, 'entry');
    takeRef(body, 'exit');
  }
  const budgets = sub(at, 'budgets', BUDGET_KEYS);
  if (budgets !== undefined) for (const key of BUDGET_KEYS) take(budgets, key, false, isCount, 'a finite number');
  takePort(at, 'in');
  takePort(at, 'out');
  if (variant === 'foreach') take(at, 'concurrency', false, isCount, 'a finite number');
  else if (variant === 'while' || variant === 'until') take(at, 'condition', false, isString, 'a string');
  else if (variant === 'retry') {
    take(at, 'maxAttempts', false, isCount, 'a finite number');
    take(at, 'onExhausted', true, oneOf('fail-run', 'emit-error'), 'one of fail-run, emit-error');
    const backoff = sub(at, 'backoff', BACKOFF_KEYS);
    if (backoff === undefined) return;
    take(backoff, 'kind', true, oneOf('fixed', 'exponential'), 'one of fixed, exponential');
    take(backoff, 'baseMs', false, isCount, 'a finite number');
  }
};

const runNode = (c: Ctx, { v, out, path, node }: Extract<Task, { k: 'node' }>): void => {
  const f = fieldsOf(c, v, path, node, NODE_KEYS);
  if (f === undefined) return;
  begin(c, v);
  const at: At = { c, f, path, node, out };
  const kind = f.get('kind');
  if (kind === 'frame') {
    out['kind'] = kind;
    takeFrame(at);
  } else if (kind === 'source' || kind === 'map' || kind === 'sink') {
    restrict(c, f, PLAIN_KEYS[kind], path, node);
    out['kind'] = kind;
    take(at, 'fn', true, isString, 'a string');
    if (f.has('params')) placeJson(c, out, 'params', f.get('params'), `${path}/params`, node);
    if (kind !== 'source') takePort(at, 'in');
    if (kind !== 'sink') takePort(at, 'out');
    if (kind !== 'source') take(at, 'concurrency', false, isCount, 'a finite number');
  } else fail(c, `${path}/kind`, node, 'expected one of source, map, sink, frame');
};

const step = (c: Ctx, t: Task): void => {
  tick(c);
  if (t.k === 'json') runJson(c, t);
  else if (t.k === 'schema') runSchema(c, t);
  else if (t.k === 'nodes') runNodes(c, t);
  else if (t.k === 'node') runNode(c, t);
  else if (t.k === 'exit') c.active.delete(t.v);
  else t.run();
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function parseFlow(input: unknown): ParseResult {
  const c: Ctx = { errors: [], seen: new Set(), fails: 0, stack: [], active: new Set(), work: 0, halt: undefined };
  const holder: Rec = {};
  const root = open(c, input, '', undefined, ROOT_KEYS, holder, 'flow');
  if (root !== undefined) {
    if (root.f.get('version') === 1) root.out['version'] = 1;
    else fail(c, '/version', undefined, 'expected version 1');
    take(root, 'id', true, isString, 'a string');
    take(root, 'name', true, isString, 'a string');
    takeNodes(root);
    takeEdges(root);
  }
  for (let t = c.stack.pop(); t !== undefined && c.halt === undefined; t = c.stack.pop()) step(c, t);
  if (c.halt !== undefined) c.errors.push({ code: 'E_SHAPE', message: c.halt, path: '' });
  if (c.errors.length === 0) return { ok: true, flow: holder['flow'] as Flow };
  return { ok: false, errors: c.errors.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code)) };
}
