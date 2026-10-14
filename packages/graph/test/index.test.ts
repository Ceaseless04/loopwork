import { describe, expect, it } from 'vitest';
// The one test that imports the package entry point (every other test imports `../src/<file>.js`): it pins the public surface.
import * as api from '../src/index.js';
import { ERROR_CODES, conformsTo, edgeId, flow, inferSchema, isAssignable, parseFlow, scopedId, validateFlow } from '../src/index.js';
import type {
  Body,
  Budgets,
  Edge,
  ErrorCode,
  Flow,
  FlowNode,
  Frame,
  JsonValue,
  ParseResult,
  PortRef,
  PortSpec,
  Schema,
  ValidationError,
  ValidationResult,
} from '../src/index.js';
import type * as impl from '../src/types.js';

// Type-level pins: vitest does not typecheck, so these are enforced ONLY by the root `pnpm typecheck` (tsc over packages/*/test).
// `pin<Equal<A, B>>(true)` compiles only when the two types are identical.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const pin = <T extends true>(value: T): T => value;

describe('GM-1: public API of @loopwork/graph', () => {
  it('GM-1: the entry point exports exactly the planned runtime names, named exports only', () => {
    expect(Object.keys(api).sort()).toEqual(
      ['ERROR_CODES', 'conformsTo', 'edgeId', 'flow', 'inferSchema', 'isAssignable', 'parseFlow', 'scopedId', 'validateFlow'].sort(),
    );
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(ERROR_CODES).toHaveLength(11);
  });

  it('GM-1: the exported types and function signatures are the spec ones', () => {
    pin<Equal<Flow, impl.Flow>>(true);
    pin<Equal<FlowNode, impl.FlowNode>>(true);
    pin<Equal<Frame, impl.Frame>>(true);
    pin<Equal<Body, impl.Body>>(true);
    pin<Equal<Budgets, impl.Budgets>>(true);
    pin<Equal<Edge, impl.Edge>>(true);
    pin<Equal<PortRef, impl.PortRef>>(true);
    pin<Equal<PortSpec, impl.PortSpec>>(true);
    pin<Equal<Schema, impl.Schema>>(true);
    pin<Equal<JsonValue, impl.JsonValue>>(true);
    pin<Equal<ErrorCode, impl.ErrorCode>>(true);
    pin<Equal<ValidationError, impl.ValidationError>>(true);
    pin<Equal<ParseResult, impl.ParseResult>>(true);
    pin<Equal<ValidationResult, impl.ValidationResult>>(true);
    pin<Equal<(typeof ERROR_CODES)[number], ErrorCode>>(true);
    pin<Equal<typeof parseFlow, (input: unknown) => ParseResult>>(true);
    pin<Equal<typeof validateFlow, (flow: Flow) => ValidationResult>>(true);
    pin<Equal<typeof inferSchema, (samples: JsonValue[]) => Schema>>(true);
    pin<Equal<typeof isAssignable, (from: Schema, to: Schema) => boolean>>(true);
    pin<Equal<typeof conformsTo, (value: JsonValue, schema: Schema) => boolean>>(true);
    pin<Equal<typeof edgeId, (e: Edge) => string>>(true);
    pin<Equal<typeof scopedId, (...parts: string[]) => string>>(true);
    pin<Equal<ReturnType<ReturnType<typeof flow>['build']>, Flow>>(true);
    expect(true).toBe(true);
  });

  it('GM-1: a flow built, validated, and ids derived through the entry point alone', () => {
    const str: Schema = { type: 'string' };
    const built = flow('f', 'f')
      .source('a', { fn: 'f', out: str })
      .sink('b', { fn: 'f', in: str })
      .edge('a.out', 'b.in')
      .build();
    const parsed = parseFlow(JSON.parse(JSON.stringify(built)));
    expect(parsed.ok).toBe(true);
    expect(validateFlow(built).ok).toBe(true);
    expect(edgeId({ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } })).toBe('a.out->b.in');
    expect(scopedId('f', 'a')).toBe('f.a');
    expect(isAssignable(inferSchema([1, 2]), { type: 'number' })).toBe(true);
    expect(conformsTo('x', str)).toBe(true);
  });
});
