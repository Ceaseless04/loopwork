import { describe, expect, it } from 'vitest';
import { edgeId, scopedId } from '../src/ids.js';
import { ERROR_CODES } from '../src/types.js';
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
} from '../src/types.js';

// Type-level pins: vitest does not typecheck, `pnpm typecheck` does (the root tsconfig covers packages/*/test).
// `pin<Equal<A, B>>(true)` compiles only when the two types are identical; `Fits<A, B>` is plain assignability.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Fits<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
const pin = <T extends true>(value: T): T => value;
type Nothing = Record<never, never>; // the empty object type, spelled so the no-empty-object-type lint stays on

const edge = (fromNode: string, fromPort: string, toNode: string, toPort: string): Edge => ({
  from: { node: fromNode, port: fromPort },
  to: { node: toNode, port: toPort },
});

describe('T10: edgeId', () => {
  it('T10: formats `${from.node}.${from.port}->${to.node}.${to.port}`', () => {
    expect(edgeId(edge('src', 'out', 'map1', 'in'))).toBe('src.out->map1.in');
  });

  it('T10: keeps scoped body node ids verbatim, including nested scopes', () => {
    expect(edgeId(edge('loop.a', 'out', 'loop.b', 'in'))).toBe('loop.a.out->loop.b.in');
    expect(edgeId(edge('outer.inner.a', 'out', 'outer.inner.b', 'in'))).toBe('outer.inner.a.out->outer.inner.b.in');
  });

  it('T10: ids of edges that differ in any one endpoint differ', () => {
    const base = edge('a', 'out', 'b', 'in');
    const ids = [
      base,
      edge('x', 'out', 'b', 'in'),
      edge('a', 'error', 'b', 'in'),
      edge('a', 'out', 'x', 'in'),
      edge('a', 'out', 'b', 'x'),
    ].map(edgeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('T10: is direction-sensitive', () => {
    expect(edgeId(edge('a', 'out', 'b', 'in'))).not.toBe(edgeId(edge('b', 'in', 'a', 'out')));
  });

  it('T10: follows the formula literally for empty strings', () => {
    expect(edgeId(edge('', '', '', ''))).toBe('.->.');
  });

  it('T10: composes with scopedId for body edges', () => {
    const e = edge(scopedId('outer', 'inner', 'a'), 'out', scopedId('outer', 'inner', 'b'), 'in');
    expect(edgeId(e)).toBe('outer.inner.a.out->outer.inner.b.in');
  });
});

describe('T10: scopedId', () => {
  it('T10: returns a single part unchanged', () => {
    expect(scopedId('node')).toBe('node');
  });

  it('T10: joins parts with a dot, nested scopes included', () => {
    expect(scopedId('frame', 'node')).toBe('frame.node');
    expect(scopedId('outer', 'inner', 'node')).toBe('outer.inner.node');
  });

  it('T10: returns the empty string for no parts', () => {
    expect(scopedId()).toBe('');
  });

  it('T10: joins empty parts without dropping them', () => {
    expect(scopedId('a', '')).toBe('a.');
    expect(scopedId('', 'b')).toBe('.b');
  });

  it('T10: is associative over already-scoped parts', () => {
    expect(scopedId(scopedId('outer', 'inner'), 'node')).toBe(scopedId('outer', scopedId('inner', 'node')));
  });
});

describe('GM-2: ERROR_CODES', () => {
  it('GM-2: lists the eleven stable codes in spec order, without duplicates', () => {
    expect([...ERROR_CODES]).toEqual([
      'E_SHAPE',
      'E_DUPLICATE_ID',
      'E_UNKNOWN_NODE',
      'E_UNKNOWN_PORT',
      'E_CYCLE',
      'E_MISSING_BUDGET',
      'E_MISSING_EXIT',
      'E_TYPE_MISMATCH',
      'E_UNCONNECTED_PORT',
      'E_BAD_LIMIT',
      'E_NESTING_DEPTH',
    ]);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('GM-2: ErrorCode is the union of ERROR_CODES, and the result types carry it', () => {
    pin<
      Equal<
        ErrorCode,
        | 'E_SHAPE'
        | 'E_DUPLICATE_ID'
        | 'E_UNKNOWN_NODE'
        | 'E_UNKNOWN_PORT'
        | 'E_CYCLE'
        | 'E_MISSING_BUDGET'
        | 'E_MISSING_EXIT'
        | 'E_TYPE_MISMATCH'
        | 'E_UNCONNECTED_PORT'
        | 'E_BAD_LIMIT'
        | 'E_NESTING_DEPTH'
      >
    >(true);
    pin<Equal<ValidationError, { code: ErrorCode; message: string; node?: string; edge?: string; path: string }>>(true);
    pin<Equal<ParseResult, { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] }>>(true);
    pin<Equal<ValidationResult, { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] }>>(true);
    const withOptionals: ValidationError = { code: 'E_CYCLE', message: 'cycle: a -> b -> a', node: 'a', edge: 'a.out->b.in', path: '/nodes' };
    const minimal: ValidationError = { code: 'E_SHAPE', message: 'not a flow', path: '' };
    expect([withOptionals.code, minimal.code]).toEqual(['E_CYCLE', 'E_SHAPE']);
  });
});

describe('T10: IR types', () => {
  it('T10: the small record types have exactly the spec shape', () => {
    pin<Equal<PortRef, { node: string; port: string }>>(true);
    pin<Equal<Edge, { from: PortRef; to: PortRef }>>(true);
    pin<Equal<Budgets, { maxIterations: number; maxDurationMs: number; maxCostUsd?: number; maxTokens?: number }>>(true);
    pin<Equal<Body, { nodes: Record<string, FlowNode>; edges: Edge[]; entry: PortRef; exit: PortRef }>>(true);
    pin<Equal<Flow, { version: 1; id: string; name: string; nodes: Record<string, FlowNode>; edges: Edge[] }>>(true);
    expect(true).toBe(true);
  });

  it('T10: node and frame discriminants match the spec', () => {
    pin<Equal<FlowNode['kind'], 'source' | 'map' | 'sink' | 'frame'>>(true);
    pin<Equal<Frame['frame'], 'foreach' | 'while' | 'until' | 'retry'>>(true);
    pin<Equal<Extract<Frame, { frame: 'retry' }>['onExhausted'], 'fail-run' | 'emit-error'>>(true);
    pin<Equal<Extract<Frame, { frame: 'retry' }>['backoff'], { kind: 'fixed' | 'exponential'; baseMs: number }>>(true);
    pin<Equal<Extract<Frame, { frame: 'while' | 'until' }>['condition'], string>>(true);
    pin<Equal<Extract<Frame, { frame: 'foreach' }>['concurrency'], number>>(true);
    pin<Equal<Extract<Frame, { frame: 'retry' }>['maxAttempts'], number>>(true);
    pin<Fits<Frame, FlowNode>>(true);
    expect(true).toBe(true);
  });

  it('T10: optional fields are optional and mandatory ones are not', () => {
    pin<Fits<Nothing, Pick<Extract<FlowNode, { kind: 'source' }>, 'params'>>>(true);
    pin<Fits<Nothing, Pick<Extract<FlowNode, { kind: 'map' }>, 'concurrency'>>>(true);
    pin<Fits<Nothing, Pick<Extract<FlowNode, { kind: 'sink' }>, 'concurrency'>>>(true);
    pin<Fits<Nothing, Pick<Budgets, 'maxCostUsd' | 'maxTokens'>>>(true);
    pin<Not<Fits<Nothing, Pick<Budgets, 'maxIterations'>>>>(true);
    pin<Not<Fits<Nothing, Pick<Budgets, 'maxDurationMs'>>>>(true);
    expect(true).toBe(true);
  });

  it('T10: Schema covers the JSON-Schema subset including the {} any-schema; PortSpec adds inferFrom', () => {
    pin<Fits<{ type: 'null' | 'boolean' | 'number' | 'integer' | 'string' }, Schema>>(true);
    pin<Fits<{ type: 'array'; items: { type: 'string' } }, Schema>>(true);
    pin<Fits<{ type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: boolean }, Schema>>(true);
    pin<Fits<{ anyOf: Schema[] }, Schema>>(true);
    pin<Fits<{ enum: JsonValue[] }, Schema>>(true);
    pin<Fits<Nothing, Schema>>(true); // only the any-schema member `{}` accepts a value with no properties
    pin<Not<Fits<null, Schema>>>(true);
    pin<Fits<{ inferFrom: JsonValue[] }, PortSpec>>(true);
    expect(true).toBe(true);
  });

  // Written out from the Schema block in SPEC-graph-model.md, NOT derived from `Schema`: it must stay independent of
  // types.ts, otherwise a member dropped from types.ts would drop out of both sides of the comparison and still pass.
  type SchemaSpecCopy =
    | { type: 'null' | 'boolean' | 'number' | 'integer' | 'string' }
    | { type: 'array'; items: SchemaSpecCopy }
    | { type: 'object'; properties: Record<string, SchemaSpecCopy>; required?: string[]; additionalProperties?: boolean }
    | { anyOf: SchemaSpecCopy[] }
    | { enum: JsonValue[] }
    | Nothing; // "any" (`{}` in the spec)

  it('T10: Schema and PortSpec are exactly the spec unions, member by member', () => {
    // `Fits` against Schema is vacuous (the any-schema member accepts any object), so pin the whole union with Equal.
    pin<Equal<Schema, SchemaSpecCopy>>(true);
    pin<Equal<PortSpec, SchemaSpecCopy | { inferFrom: JsonValue[] }>>(true);
    expect(true).toBe(true);
  });

  it('T10: JsonValue accepts nested JSON and rejects non-JSON values', () => {
    const nested: JsonValue = { a: [1, 2.5, null, true, 'x', { b: [] }], c: {} };
    expect(JSON.parse(JSON.stringify(nested))).toEqual(nested);
    pin<Not<Fits<undefined, JsonValue>>>(true);
    pin<Not<Fits<() => void, JsonValue>>>(true);
    pin<Not<Fits<{ a: undefined }, JsonValue>>>(true);
    pin<Not<Fits<Date, JsonValue>>>(true);
  });

  it('T10: rejects shapes that drift from the spec', () => {
    type Foreach = { kind: 'frame'; frame: 'foreach'; body: Body; budgets: Budgets; concurrency: number; in: PortSpec; out: PortSpec };
    pin<Fits<Foreach, FlowNode>>(true);
    pin<Not<Fits<Omit<Foreach, 'budgets'>, FlowNode>>>(true);
    pin<Not<Fits<Omit<Foreach, 'concurrency'>, FlowNode>>>(true);
    pin<Not<Fits<Omit<Foreach, 'body'>, FlowNode>>>(true);
    pin<Not<Fits<Omit<Foreach, 'in'>, FlowNode>>>(true);
    pin<Not<Fits<Omit<Foreach, 'out'>, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'frame'; frame: 'while'; body: Body; budgets: Budgets; in: PortSpec; out: PortSpec }, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'frame'; frame: 'until'; body: Body; budgets: Budgets; in: PortSpec; out: PortSpec }, FlowNode>>>(true);
    pin<
      Not<Fits<
        {
          kind: 'frame';
          frame: 'retry';
          body: Body;
          budgets: Budgets;
          maxAttempts: number;
          backoff: { kind: 'linear'; baseMs: number };
          onExhausted: 'fail-run';
          in: PortSpec;
          out: PortSpec;
        },
        FlowNode
      >>
    >(true);
    pin<Not<Fits<{ kind: 'frame'; frame: 'loop'; body: Body; budgets: Budgets; in: PortSpec; out: PortSpec }, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'source'; fn: string }, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'map'; fn: string; out: PortSpec }, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'sink'; fn: string }, FlowNode>>>(true);
    pin<Not<Fits<{ kind: 'transform'; fn: string; in: PortSpec; out: PortSpec }, FlowNode>>>(true);
    pin<Not<Fits<{ maxIterations: number }, Budgets>>>(true);
    pin<Not<Fits<{ maxIterations: string; maxDurationMs: number }, Budgets>>>(true);
    pin<Not<Fits<{ version: 2; id: string; name: string; nodes: Record<string, FlowNode>; edges: Edge[] }, Flow>>>(true);
    pin<Not<Fits<{ version: 1; id: string; name: string; nodes: Record<string, FlowNode> }, Flow>>>(true);
    pin<Not<Fits<{ nodes: Record<string, FlowNode>; edges: Edge[]; entry: PortRef }, Body>>>(true);
    expect(true).toBe(true);
  });
});

describe('T10: sample flows of each frame kind typecheck', () => {
  const anyPort: PortSpec = {};
  const num: Schema = { type: 'number' };
  const budgets: Budgets = { maxIterations: 10, maxDurationMs: 60_000 };
  const body = (): Body => ({
    nodes: {
      step: { kind: 'map', fn: 'double', in: num, out: num, concurrency: 2 },
    },
    edges: [],
    entry: { node: 'step', port: 'in' },
    exit: { node: 'step', port: 'out' },
  });
  const frameEdges: Edge[] = [
    { from: { node: 'src', port: 'out' }, to: { node: 'f', port: 'in' } },
    { from: { node: 'f', port: 'out' }, to: { node: 'sink', port: 'in' } },
  ];
  const wrap = (id: string, frame: Frame): Flow => ({
    version: 1,
    id,
    name: id,
    nodes: {
      src: { kind: 'source', fn: 'numbers', params: { count: 3, tags: ['a', null] }, out: { inferFrom: [1, 2.5] } },
      f: frame,
      sink: { kind: 'sink', fn: 'print', in: anyPort, concurrency: 1 },
    },
    edges: frameEdges,
  });

  it('T10: foreach frame', () => {
    const flow = wrap('foreach-sample', {
      kind: 'frame',
      frame: 'foreach',
      body: body(),
      budgets: { ...budgets, maxCostUsd: 1.5, maxTokens: 1000 },
      concurrency: 4,
      in: { type: 'array', items: num },
      out: { type: 'array', items: num },
    });
    expect(flow.nodes['f']).toMatchObject({ kind: 'frame', frame: 'foreach', concurrency: 4 });
  });

  it('T10: while and until frames', () => {
    for (const frame of ['while', 'until'] as const) {
      const flow = wrap(`${frame}-sample`, { kind: 'frame', frame, body: body(), budgets, condition: 'isSmall', in: num, out: num });
      expect(flow.nodes['f']).toMatchObject({ kind: 'frame', frame, condition: 'isSmall' });
    }
  });

  it('T10: retry frame, with and without the emit-error port', () => {
    for (const onExhausted of ['fail-run', 'emit-error'] as const) {
      const flow = wrap(`retry-${onExhausted}`, {
        kind: 'frame',
        frame: 'retry',
        body: body(),
        budgets,
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseMs: 0 },
        onExhausted,
        in: { anyOf: [num, { type: 'null' }] },
        out: { enum: [1, 'two', null] },
      });
      expect(flow.nodes['f']).toMatchObject({ kind: 'frame', frame: 'retry', onExhausted });
    }
  });

  it('T10: frames nest, and body edges are addressed by their scoped ids', () => {
    const inner: Frame = {
      kind: 'frame',
      frame: 'retry',
      body: body(),
      budgets,
      maxAttempts: 2,
      backoff: { kind: 'fixed', baseMs: 100 },
      onExhausted: 'emit-error',
      in: num,
      out: num,
    };
    const outer: Frame = {
      kind: 'frame',
      frame: 'foreach',
      body: { nodes: { inner }, edges: [], entry: { node: 'inner', port: 'in' }, exit: { node: 'inner', port: 'out' } },
      budgets,
      concurrency: 1,
      in: num,
      out: num,
    };
    const flow = wrap('nested-sample', outer);
    expect(flow.nodes['f']).toMatchObject({ frame: 'foreach' });
    const bodyEdge: Edge = { from: { node: scopedId('f', 'inner'), port: 'out' }, to: { node: scopedId('f', 'sink'), port: 'in' } };
    expect(edgeId(bodyEdge)).toBe('f.inner.out->f.sink.in');
  });
});
