# Spec: graph-model (`@loopwork/graph`)

Depends on: none. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The typed graph IR for Loopwork flows, and the static validator that rejects bad flows **before** any run
(ADR 0001). It is pure data and pure functions: no I/O, no Postgres, no engine.

Users: `engine-core` (executes validated flows), `run-service` (validates on `startRun`), `ui-viewer` (renders
the same IR). Success: a flow either validates with zero errors, or yields a complete list of errors with stable
codes and precise locations.

## Tech Stack

TypeScript only. No runtime dependencies. No schema library: a small hand-written JSON-Schema-subset checker.

## Commands

```
pnpm --filter @loopwork/graph build
pnpm --filter @loopwork/graph test
pnpm --filter @loopwork/graph typecheck
```

## Project Structure

```
packages/graph/
  src/index.ts          public exports only
  src/types.ts          Flow, Node, Edge, Frame, Budgets, Schema, JsonValue
  src/schema.ts         inferSchema, isAssignable, conformsTo
  src/parse.ts          parseFlow(unknown): structural parse (shape, not semantics)
  src/validate.ts       validateFlow: runs the checkers below, concatenates and sorts their errors
  src/validate-structure.ts  E_DUPLICATE_ID, E_UNKNOWN_NODE, E_UNKNOWN_PORT, E_NESTING_DEPTH
  src/validate-cycles.ts     E_CYCLE
  src/validate-limits.ts     E_MISSING_BUDGET, E_MISSING_EXIT, E_BAD_LIMIT
  src/validate-types.ts      E_TYPE_MISMATCH, E_UNCONNECTED_PORT, E_SHAPE for an unresolved inferFrom
  src/walk.ts           scope walker (outer graph + every body) and the JSON-pointer path convention
  src/builder.ts        flow() fluent TS builder producing a Flow
  src/ids.ts            scoped node ids and edge ids
  test/*.test.ts        test/codes/e-*.test.ts: one file per error code
  test/fixtures/*.flow.json
```

## The IR

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

// JSON-Schema subset. Anything outside it is rejected by parseFlow.
type Schema =
  | { type: 'null' | 'boolean' | 'number' | 'integer' | 'string' }
  | { type: 'array'; items: Schema }
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: boolean }
  | { anyOf: Schema[] }
  | { enum: JsonValue[] }
  | {};                                   // "any"

type PortSpec = Schema | { inferFrom: JsonValue[] };   // inferFrom resolved at parse time via inferSchema

type Flow = { version: 1; id: string; name: string; nodes: Record<string, FlowNode>; edges: Edge[] };
type Edge = { from: PortRef; to: PortRef };           // edge id = `${from.node}.${from.port}->${to.node}.${to.port}`
type PortRef = { node: string; port: string };

type FlowNode =
  | { kind: 'source'; fn: string; params?: JsonValue; out: PortSpec }                       // ports: out
  | { kind: 'map';    fn: string; params?: JsonValue; in: PortSpec; out: PortSpec; concurrency?: number } // in, out
  | { kind: 'sink';   fn: string; params?: JsonValue; in: PortSpec; concurrency?: number }  // in
  | Frame;

type Budgets = { maxIterations: number; maxDurationMs: number; maxCostUsd?: number; maxTokens?: number };
type Body = { nodes: Record<string, FlowNode>; edges: Edge[]; entry: PortRef; exit: PortRef };

type Frame =
  | { kind: 'frame'; frame: 'foreach'; body: Body; budgets: Budgets; concurrency: number; in: PortSpec; out: PortSpec }
  | { kind: 'frame'; frame: 'while' | 'until'; body: Body; budgets: Budgets; condition: string /* fn */; conditionParams?: JsonValue /* the predicate's params, like `params` on a node */; in: PortSpec; out: PortSpec }
  | { kind: 'frame'; frame: 'retry'; body: Body; budgets: Budgets; maxAttempts: number;
      backoff: { kind: 'fixed' | 'exponential'; baseMs: number }; onExhausted: 'fail-run' | 'emit-error'; in: PortSpec; out: PortSpec };
```

Semantics the IR encodes (executed by `engine-core`, specified in `SPEC-engine-core.md`):
- Frame ports are `in` and `out`; a `retry` frame with `onExhausted: 'emit-error'` also has an `error` port.
- `maxCostUsd` / `maxTokens` are accepted and carried but **not enforced in Phase 1**; `maxIterations` and `maxDurationMs` are mandatory and enforced.
- Body nodes are addressed by **scoped id** `frameId.nodeId` (nesting: `outer.inner.node`). Edge ids inside a body are scoped the same way.
- Frames may nest. The outer graph and every body are DAGs. Repetition exists only via the frame kind.

## Public API

```ts
parseFlow(input: unknown): ParseResult          // { ok:true, flow } | { ok:false, errors }  shape only; resolves inferFrom
validateFlow(flow: Flow): ValidationResult      // { ok:true, flow } | { ok:false, errors: ValidationError[] }
inferSchema(samples: JsonValue[]): Schema       // empty samples -> {}
isAssignable(from: Schema, to: Schema): boolean // from's values are always acceptable to `to`
conformsTo(value: JsonValue, schema: Schema): boolean
flow(id: string, name: string): FlowBuilder     // fluent builder; build() returns a Flow, does not validate
edgeId(e: Edge): string
scopedId(...parts: string[]): string
type ValidationError = { code: ErrorCode; message: string; node?: string; edge?: string; path: string /* JSON pointer into the flow */ }
```

Parse/validate boundary: `parseFlow` checks structure and the JSON type of every field that is present. The semantic
fields `budgets.maxIterations`, `budgets.maxDurationMs`, `concurrency`, `condition`, `maxAttempts` and `backoff.baseMs`
may be absent or out of range in a parsed flow; `validateFlow` reports those (`E_MISSING_BUDGET`, `E_MISSING_EXIT`,
`E_BAD_LIMIT`) and therefore reads them defensively. A flow built with `flow()` that contains `{ inferFrom }` is resolved
by passing it through `parseFlow`. Schemas and `inferFrom` samples must be well-formed (exactly one union member, plain
JSON values): `inferSchema`, `isAssignable` and `conformsTo` assume it.

`validateFlow`'s contract is that its input came through `parseFlow` (so `run-service` always calls `parseFlow` before
`validateFlow`). Out-of-contract input (for example a `null` node or `edges` that is not an array) may make it throw. The one
parse-stage condition it still checks is an unresolved `{ inferFrom }` (`E_SHAPE`, message `unresolved inferFrom: run
parseFlow`, at `<node path>/in` or `/out`). Errors are sorted by `path` as plain strings (UTF-16 code-unit order, not numeric:
`/edges/10` sorts before `/edges/2`); ties keep the checker order (structure, cycles, limits, types).

`flow()` builder: `edge(from, to)` takes `'node.port'` strings and splits at the **last** `.` (node ids may be scoped, ports
never contain `.`); a string with no `.` yields an empty port rather than an error. `build()` returns a lossless deep copy
(`structuredClone`) and neither validates nor sanitises, so `NaN`, `Infinity` or `undefined` reach `parseFlow` intact. Frames
are added with a complete `Frame` object (no callback form); their body edges are `{ node, port }` objects, not strings.

Public entry (`src/index.ts`) exports exactly: the functions `parseFlow`, `validateFlow`, `inferSchema`, `isAssignable`,
`conformsTo`, `flow`, `edgeId`, `scopedId`; the constant `ERROR_CODES` (frozen, same order as the table below); and the types
`Body`, `Budgets`, `Edge`, `ErrorCode`, `Flow`, `FlowNode`, `Frame`, `JsonValue`, `ParseResult`, `PortRef`, `PortSpec`,
`Schema`, `ValidationError`, `ValidationResult`. `FlowBuilder` is not exported by name.

`parseFlow` never throws, and for JSON data (the output of `JSON.parse`, or plain objects built from it) it does
bounded work: an array whose `length` is not a non-negative integer is `E_SHAPE` at `<path>/length`. Work is counted in
units: one per value read or container visited, plus one per character beyond 256 of every object key visited and of
every recorded error's path, message and node id. Once 5,000,000 units are spent, or a 250,001st distinct error is
found, parsing stops and the result is `ok: false` with one extra `E_SHAPE` at `''` saying which limit was hit. A huge
sparse array, a shared-subtree "DAG bomb", a long-key bomb or a flood of long error paths is therefore never reported
as valid and finishes in a few seconds. When the error limit is hit, the errors kept are those found first; within one
array or record they are taken in document order, but top-level fields are checked in a fixed order (edges before
nodes), so a kept set is not necessarily a prefix of the document. Getters, Proxy traps and non-enumerable key blobs are
outside this guarantee: they are never invoked for unknown keys and never make `parseFlow` throw, but their running
time is not bounded.

Error codes (stable; additive only):

| Code | Raised when |
|---|---|
| `E_SHAPE` | not a Flow (parse stage): missing/ill-typed fields; **unknown extra keys** on any closed object (flow, node, frame, body, budgets, backoff, edge, port ref); unsupported schema keyword, a schema that is not exactly one union member, empty `anyOf`/`enum`; unknown `kind`/`frame`; non-finite numbers or `undefined` values; `inferFrom` samples that are not plain JSON values; an `{ inferFrom }` that reaches `validateFlow` unresolved |
| `E_DUPLICATE_ID` | node id contains `.` or `->` (ids are record keys, so a literal repeat cannot occur; these two collide in the scoped-id / edge-id namespace), at the node's pointer |
| `E_UNKNOWN_NODE` / `E_UNKNOWN_PORT` | edge, body `entry` or body `exit` references a missing node, or a port the node kind doesn't have, or uses a port in the wrong direction (an edge's `from` must be `out` or `error`, its `to` must be `in`; body `entry` must be `in`, `exit` must be `out`): direction misuse is `E_UNKNOWN_PORT` |
| `E_CYCLE` | the outer graph or any body has a cycle: one error per scope, at the scope's pointer, `node` is the cycle's first node; message is `cycle: a -> b -> a` with scoped ids, the first id repeated at the end |
| `E_MISSING_BUDGET` | frame lacks `maxIterations` or `maxDurationMs`, or either is not a positive integer |
| `E_MISSING_EXIT` | `while`/`until` without `condition` (at `.../condition`); `retry` with a numeric `maxAttempts < 1` (at `.../maxAttempts`; this value is `E_MISSING_EXIT` only, never also `E_BAD_LIMIT`); frame body has no path from entry to exit (at `<scope>/nodes/<frame>/body/exit`; skipped when the entry or exit node is unknown, which is `E_UNKNOWN_NODE`'s to report) |
| `E_TYPE_MISMATCH` | an edge's `from` schema is not assignable to its `to` schema (a retry frame's `error` port carries `{ message: string, item: {} }`, both required); a frame's `in` not assignable to its body entry port's schema, or the body exit port's schema not assignable to the frame's `out` (frame boundary, at `.../body/entry` and `.../body/exit`); `while`/`until` body output not assignable to body input (state loop, at `.../body`). An untyped (`{}`) source is assignable only to an untyped target, so `{}` to a typed port is a mismatch (ADR 0004). The message embeds both schemas as JSON |
| `E_UNCONNECTED_PORT` | a required input port has no incoming edge (a frame's body entry node counts as fed by the frame boundary); a source/map/frame `out` with no outgoing edge **is allowed** (output is dropped) |
| `E_BAD_LIMIT` | `concurrency` not a positive integer (a `foreach` frame requires it: absent is `E_BAD_LIMIT`; on `map`/`sink` it is optional); `retry` `maxAttempts` absent or not an integer (a number below 1 is `E_MISSING_EXIT` instead); `backoff.baseMs` absent, negative or not a number |
| `E_NESTING_DEPTH` | frames nested deeper than 8 (guards the engine and the UI): reported at every frame beyond the 8th level, not only the first |

## Code Style

```ts
const cycle = findCycle(nodeIds, edges);
if (cycle) errors.push({ code: 'E_CYCLE', message: `cycle: ${cycle.join(' -> ')}`, path: scopePath });
```
Collect all errors; sort by `path` for stable output. Cycle detection is iterative (no recursion limit on large flows).

## Testing Strategy

Unit tests only. Table-driven tests: one file per error code with a minimal failing flow and the expected `code` + `path`. Property-style test for `inferSchema`: every sample passed to `inferSchema(samples)` must satisfy `conformsTo(sample, result)`. Golden fixtures in `test/fixtures/*.flow.json` (also reused by other modules): `simple-pipeline`, `foreach-100k`, `while-counter`, `retry-flaky`, `nested-frames`. The fixtures are not exported by the package: other modules import them by relative path with `with { type: 'json' }` and need their own `*.flow.json` module declaration (see `packages/graph/test/json-modules.d.ts`).

## Boundaries

- Always: report every error, not the first; keep error codes stable; keep the package free of I/O and of Node-only APIs so `ui-viewer` can import it in the browser.
- Ask first: widening the Schema subset; adding a node or frame kind; changing a `Budgets` field.
- Never: execute user code; resolve `fn` names (that is `run-service`'s registry check); import from any other `@loopwork/*` package.

## Success Criteria

- **GM-1** A valid flow of each fixture validates `ok: true`.
- **GM-2** For every code in the table, a minimal flow produces exactly that code with the correct `path`; the table in this spec and the `ErrorCode` union match (test fails if one side gains a code).
- **GM-3** A frame missing either mandatory budget fails with `E_MISSING_BUDGET`; the same flow with budgets passes.
- **GM-4** A cycle in the outer graph, in a body, and across a nested frame's body each yield `E_CYCLE`; the same topology expressed with a frame validates.
- **GM-5** `while` with a body whose output schema is not assignable to its input yields `E_TYPE_MISMATCH`.
- **GM-6** `inferSchema` merges heterogeneous samples (`1`, `2.5` → `number`; objects with differing keys → optional properties; mixed kinds → `anyOf`); inferred schema accepts all its samples.
- **GM-7** `isAssignable` is reflexive and transitive on the fixture schemas; `integer` is assignable to `number`, not the reverse.
- **GM-8** Validating a 5,000-node flow completes in under 1 s (guards accidental O(n²)).
- **GM-9** `packages/graph` has no imports of `node:*` modules (lint rule or test).

## Open Questions

None blocking. Note: schema `anyOf` assignability is implemented conservatively (a union is assignable only if every member is); document false negatives rather than risk false positives.

Known false negatives of `isAssignable` (so `E_TYPE_MISMATCH` can fire on an edge that is fine at runtime; the full list is in the `isAssignable` comment in `src/schema.ts`):
- An inferred object schema is never closed, so it never assigns to a closed hand-written target.
- An open source that lacks one of a target's optional properties is rejected.
- Integral samples infer `integer`: `inferFrom [{ price: 9.99 }]` does not assign to `inferFrom [{ price: 10 }]`.
- An empty-array sample infers `items: {}`, so it does not assign to an array of a typed item (this bites a `while` state with `items: []`).
- Merged inference cannot feed a discriminated union; `boolean` does not assign to `enum [true, false]` or to `anyOf` of the two literals.
- An untyped (`{}`) source never feeds a typed port (ADR 0004).

Performance limit: the body-reachability check in `E_MISSING_EXIT` is linear in nodes plus edges (adjacency map); GM-8 is measured on a 5,000-node flow and on a 5,000-node frame body.
