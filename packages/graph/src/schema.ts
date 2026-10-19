import type { JsonValue, Schema } from './types.js';

type ObjectSchema = Extract<Schema, { type: 'object' }>;
type ArraySchema = Extract<Schema, { type: 'array' }>;
type AnyOfSchema = Extract<Schema, { anyOf: Schema[] }>;
type EnumSchema = Extract<Schema, { enum: JsonValue[] }>;

// Schema keywords are read as OWN properties only, so nothing is ever resolved through Object.prototype.
const has = (o: object, key: string): boolean => Object.hasOwn(o, key);
const isAnyOf = (s: Schema): s is AnyOfSchema => has(s, 'anyOf');
const isEnum = (s: Schema): s is EnumSchema => has(s, 'enum');
const typeOf = (s: Schema): unknown => (has(s, 'type') && 'type' in s ? s.type : undefined);
const isAny = (s: Schema): boolean => !isAnyOf(s) && !isEnum(s) && typeOf(s) === undefined;
const isArray = (s: Schema): s is ArraySchema => typeOf(s) === 'array';
const isObject = (s: Schema): s is ObjectSchema => typeOf(s) === 'object';

// A boolean decision tree evaluated without recursion: an AND (`or: false`) or OR (`or: true`) over sub-questions.
type Frame<T> = { or: boolean; items: T[]; i: number };
const all = <T>(items: T[]): Frame<T> => ({ or: false, items, i: 0 });
const some = <T>(items: T[]): Frame<T> => ({ or: true, items, i: 0 });

// `step` answers a question outright (boolean) or defers to a frame of sub-questions. The frames live on an explicit
// stack, so 50,000 levels of nesting cost heap, not call stack. Each question is asked at most once, so the cost is the
// number of distinct (from, to) pairs reached: linear for matching structures, a product for anyOf/enum pairs.
const solve = <T extends object>(root: T, step: (question: T) => boolean | Frame<T>): boolean => {
  const stack: Array<Frame<T>> = [];
  let answer: boolean | undefined;
  const ask = (question: T): void => {
    const r = step(question);
    if (typeof r === 'boolean') answer = r;
    else stack.push(r);
  };
  ask(root);
  for (let f = stack.at(-1); f !== undefined; f = stack.at(-1)) {
    if (answer !== undefined) {
      if (answer === f.or) {
        stack.pop(); // an AND saw false, or an OR saw true: the frame is decided
        continue;
      }
      answer = undefined;
    }
    const next = f.items[f.i++];
    if (next === undefined) {
      stack.pop();
      answer = !f.or; // exhausted: an AND held, an OR found nothing
    } else ask(next);
  }
  return answer === true;
};

// Deep JSON equality, iterative. Own keys only; 0 and -0 are equal, NaN equals nothing.
const jsonEqual = (a: JsonValue, b: JsonValue): boolean => {
  const stack: Array<readonly [JsonValue, JsonValue]> = [[a, b]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [x, y] = top;
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      x.forEach((xv, i) => stack.push([xv, y[i] ?? null]));
    } else {
      if (Object.keys(x).length !== Object.keys(y).length) return false;
      for (const [k, xv] of Object.entries(x)) {
        const yv = has(y, k) ? y[k] : undefined;
        if (yv === undefined) return false;
        stack.push([xv, yv]);
      }
    }
  }
  return true;
};

// `undefined` is the any-schema.
const PRIMITIVES = new Map<unknown, (value: JsonValue) => boolean>([
  [undefined, () => true],
  ['null', (v) => v === null],
  ['boolean', (v) => typeof v === 'boolean'],
  ['string', (v) => typeof v === 'string'],
  ['number', (v) => Number.isFinite(v)],
  ['integer', (v) => Number.isInteger(v)],
]);

type ValueQuestion = readonly [value: JsonValue, schema: Schema];

const conformsStep = ([value, schema]: ValueQuestion): boolean | Frame<ValueQuestion> => {
  if (isAnyOf(schema)) return some(schema.anyOf.map((member): ValueQuestion => [value, member]));
  if (isEnum(schema)) return schema.enum.some((member) => jsonEqual(value, member));
  if (isArray(schema)) return Array.isArray(value) && all(value.map((item): ValueQuestion => [item, schema.items]));
  if (isObject(schema)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    if (schema.required?.some((key) => !has(value, key))) return false;
    const items: ValueQuestion[] = [];
    for (const [key, child] of Object.entries(value)) {
      const property = has(schema.properties, key) ? schema.properties[key] : undefined;
      if (property !== undefined) items.push([child, property]);
      else if (schema.additionalProperties === false) return false;
    }
    return all(items);
  }
  return PRIMITIVES.get(typeOf(schema))?.(value) === true; // an unknown `type` accepts nothing
};

type SchemaQuestion = readonly [from: Schema, to: Schema];

const objectStep = (from: ObjectSchema, to: ObjectSchema): boolean | Frame<SchemaQuestion> => {
  const requiredFrom = new Set(from.required);
  const requiredTo = new Set(to.required);
  const closedFrom = from.additionalProperties === false;
  for (const key of requiredTo) if (!requiredFrom.has(key)) return false;
  if (to.additionalProperties === false) {
    if (!closedFrom) return false;
    for (const key of Object.keys(from.properties)) if (!has(to.properties, key)) return false;
  }
  const items: SchemaQuestion[] = [];
  for (const [key, toProperty] of Object.entries(to.properties)) {
    const fromProperty = has(from.properties, key) ? from.properties[key] : undefined;
    if (fromProperty !== undefined) items.push([fromProperty, toProperty]);
    else if (!isAny(toProperty) && !(closedFrom && !requiredTo.has(key))) return false;
  }
  return all(items);
};

const assignableStep = ([from, to]: SchemaQuestion): boolean | Frame<SchemaQuestion> => {
  if (isAny(to)) return true;
  if (isEnum(from)) return from.enum.every((member) => conformsTo(member, to));
  if (isAnyOf(from)) return all(from.anyOf.map((member): SchemaQuestion => [member, to]));
  if (isAnyOf(to)) return some(to.anyOf.map((member): SchemaQuestion => [from, member]));
  if (isAny(from)) return false;
  if (isEnum(to)) return typeOf(from) === 'null' && to.enum.includes(null);
  if (isArray(from) && isArray(to)) return all([[from.items, to.items]]);
  if (isObject(from) && isObject(to)) return objectStep(from, to);
  const fromType = typeOf(from);
  const toType = typeOf(to);
  return fromType === toType || (fromType === 'integer' && toType === 'number');
};

/**
 * Does `value` satisfy `schema`? JSON validity only: NaN and the infinities are not JsonValues and fail `number` and
 * `integer` (and every enum, since NaN equals nothing); the any-schema and the unchecked extra properties of an open
 * object do not inspect the values they accept. Keys are matched as own properties (`__proto__`, `constructor` are
 * ordinary keys). `enum` is deep JSON equality; `anyOf` is "some member conforms" (an empty anyOf or enum accepts
 * nothing). Iterative, linear in value size times schema size along each path, never mutates its inputs.
 * Inputs must be well-formed Schema union members (exactly one of the union shapes, non-empty anyOf/enum); parseFlow
 * guarantees this and rejects everything else with E_SHAPE; behaviour on other inputs is unspecified.
 */
export function conformsTo(value: JsonValue, schema: Schema): boolean {
  return solve<ValueQuestion>([value, schema], conformsStep);
}

/**
 * Are all values accepted by `from` also accepted by `to`? SOUND, deliberately INCOMPLETE: true is always right, false
 * may be a false negative. Never mutates its inputs; iterative, so schema depth does not matter.
 *
 * Rules (checked in this order):
 *  - `to` is the any-schema: true.
 *  - `from` is an enum: every member must conform to `to` (exact, so enum -> anyOf/enum/anything is complete).
 *  - `from` is an anyOf: every member must be assignable to `to`.
 *  - `to` is an anyOf: `from` must be assignable to AT LEAST ONE member.
 *  - `from` is the any-schema (and `to` is anything else): false.
 *  - `to` is an enum: only `null` qualifies, when the enum lists null; any other non-enum source may take unlisted values.
 *  - arrays are covariant in `items`; `integer` -> `number` is the only widening between primitives.
 *  - objects: every key `to` requires must be required in `from`; every property both define must be assignable; a
 *    property `to` defines and `from` omits is fine only if `to` does not require it and `from` is closed
 *    (additionalProperties: false), or if `to` types it as the any-schema (an open `from` could otherwise carry any
 *    value under that key); if `to` is closed, `from` must be closed and define no property `to` lacks.
 *
 * Documented false negatives (each is a choice for soundness, not an oversight):
 *  - anyOf TARGET splits: BOOL -> anyOf(enum[true], enum[false]) is false although every boolean is one of the two,
 *    because only one target member is ever consulted for the whole source. The same holds for objects whose property
 *    values are split across several target members. (An enum SOURCE is checked member by member, so it is exact.)
 *  - an open source object never satisfies a target property it does not define (unless that property is any-typed).
 *  - closed empty containers (e.g. a closed `{}` object) are not recognised as single-valued enum members.
 *  - transitivity can therefore only be lost through these incompletenesses, never through an unsound "true".
 * Cost: linear when structures line up (properties paired by key, items by position); unions and enums are compared
 * member by member, so anyOf -> anyOf asks |from.anyOf| x |to.anyOf| sub-questions (about 5 s at 4,000 x 4,000 members)
 * and enum -> enum / enum -> anyOf costs |enum| x |target|. Inferred schemas have at most six anyOf members, so only
 * large hand-written unions get there.
 * Inputs must be well-formed Schema union members (exactly one of the union shapes, non-empty anyOf/enum); parseFlow
 * guarantees this and rejects everything else with E_SHAPE; behaviour on other inputs is unspecified.
 */
export function isAssignable(from: Schema, to: Schema): boolean {
  return solve<SchemaQuestion>([from, to], assignableStep);
}

// Mutable accumulator behind inferSchema: a set-like summary of everything seen at one position, so the result does
// not depend on sample order. `items`/`obj` exist once at least one array/object has been seen there.
type Acc = {
  nul: boolean;
  bool: boolean;
  int: boolean;
  num: boolean;
  str: boolean;
  items: Acc | undefined;
  obj: { count: number; props: Map<string, { acc: Acc; count: number }> } | undefined;
  schema: Schema;
};
const newAcc = (): Acc => ({ nul: false, bool: false, int: false, num: false, str: false, items: undefined, obj: undefined, schema: {} });

const build = (acc: Acc): Schema => {
  const members: Schema[] = [];
  if (acc.nul) members.push({ type: 'null' });
  if (acc.bool) members.push({ type: 'boolean' });
  if (acc.int || acc.num) members.push({ type: acc.num ? 'number' : 'integer' });
  if (acc.str) members.push({ type: 'string' });
  if (acc.items) members.push({ type: 'array', items: acc.items.schema });
  const obj = acc.obj;
  if (obj) {
    const props = [...obj.props].sort(([a], [b]) => (a < b ? -1 : 1));
    members.push({
      type: 'object',
      properties: Object.fromEntries(props.map(([key, p]) => [key, p.acc.schema])),
      required: props.filter(([, p]) => p.count === obj.count).map(([key]) => key),
    });
  }
  const [only] = members;
  return members.length > 1 ? { anyOf: members } : (only ?? {});
};

/**
 * Infers one schema accepting every sample. Decisions the spec leaves open (all pinned by tests):
 *  - [] gives the any-schema `{}`; an array with no items anywhere gives `items: {}`; empty arrays add no item info.
 *  - Numbers: all integral (1.0 included) gives `integer`, any non-integral gives `number`; inside an anyOf they
 *    collapse into one member. NaN/Infinity are not JSON; they would infer `number` and then fail `conformsTo`.
 *  - Objects: properties are the union of keys, `required` the keys present in EVERY object seen at that position
 *    (so counted over the samples where the parent exists), sorted; arrays pool the items of all arrays seen there.
 *  - Mixed kinds give a flat, deduplicated anyOf ordered null, boolean, integer|number, string, array, object. A single
 *    kind is never wrapped. Never emits `enum`; never sets `additionalProperties`.
 *  - Order-independent and duplicate-indifferent: the result depends only on the SET of samples (property keys are
 *    sorted too, so even the key order of the output is deterministic).
 *  - Keys are own keys held in a Map and emitted via Object.fromEntries: `__proto__` is an ordinary key, no pollution.
 * Iterative (explicit stacks) and linear in the total input size, apart from sorting each object's keys. Inputs are
 * only read. Samples must be JSON-valid (parseFlow checks them).
 */
export function inferSchema(samples: JsonValue[]): Schema {
  const root = newAcc();
  const work: Array<readonly [Acc, JsonValue]> = [];
  for (const sample of samples) {
    work.push([root, sample]);
    for (let top = work.pop(); top !== undefined; top = work.pop()) {
      const [acc, value] = top;
      if (value === null) acc.nul = true;
      else if (typeof value === 'boolean') acc.bool = true;
      else if (typeof value === 'number') {
        if (Number.isInteger(value)) acc.int = true;
        else acc.num = true;
      } else if (typeof value === 'string') acc.str = true;
      else if (Array.isArray(value)) {
        const items = (acc.items ??= newAcc());
        for (const item of value) work.push([items, item]);
      } else {
        const obj = (acc.obj ??= { count: 0, props: new Map() });
        obj.count++;
        for (const [key, child] of Object.entries(value)) {
          let prop = obj.props.get(key);
          if (prop === undefined) obj.props.set(key, (prop = { acc: newAcc(), count: 0 }));
          prop.count++;
          work.push([prop.acc, child]);
        }
      }
    }
  }
  // Parents are discovered before their children, so building in reverse order finds every child already built.
  const order: Acc[] = [];
  const pending = [root];
  for (let acc = pending.pop(); acc !== undefined; acc = pending.pop()) {
    order.push(acc);
    if (acc.items) pending.push(acc.items);
    for (const prop of acc.obj?.props.values() ?? []) pending.push(prop.acc);
  }
  for (const acc of order.reverse()) acc.schema = build(acc);
  return root.schema;
}
