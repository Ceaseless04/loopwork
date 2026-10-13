export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

// JSON-Schema subset. Anything outside it is rejected by parseFlow.
export type Schema =
  | { type: 'null' | 'boolean' | 'number' | 'integer' | 'string' }
  | { type: 'array'; items: Schema }
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: boolean }
  | { anyOf: Schema[] }
  | { enum: JsonValue[] }
  | Record<never, never>; // "any": the empty object type, spelled so the no-empty-object-type lint stays on

// inferFrom is resolved at parse time via inferSchema.
export type PortSpec = Schema | { inferFrom: JsonValue[] };

export type PortRef = { node: string; port: string };
// edge id = `${from.node}.${from.port}->${to.node}.${to.port}`
export type Edge = { from: PortRef; to: PortRef };

export type Flow = { version: 1; id: string; name: string; nodes: Record<string, FlowNode>; edges: Edge[] };

export type FlowNode =
  | { kind: 'source'; fn: string; params?: JsonValue; out: PortSpec }
  | { kind: 'map'; fn: string; params?: JsonValue; in: PortSpec; out: PortSpec; concurrency?: number }
  | { kind: 'sink'; fn: string; params?: JsonValue; in: PortSpec; concurrency?: number }
  | Frame;

export type Budgets = { maxIterations: number; maxDurationMs: number; maxCostUsd?: number; maxTokens?: number };
export type Body = { nodes: Record<string, FlowNode>; edges: Edge[]; entry: PortRef; exit: PortRef };

export type Frame =
  | { kind: 'frame'; frame: 'foreach'; body: Body; budgets: Budgets; concurrency: number; in: PortSpec; out: PortSpec }
  | { kind: 'frame'; frame: 'while' | 'until'; body: Body; budgets: Budgets; condition: string; in: PortSpec; out: PortSpec }
  | {
      kind: 'frame';
      frame: 'retry';
      body: Body;
      budgets: Budgets;
      maxAttempts: number;
      backoff: { kind: 'fixed' | 'exponential'; baseMs: number };
      onExhausted: 'fail-run' | 'emit-error';
      in: PortSpec;
      out: PortSpec;
    };

// Stable and additive only; scripts/test/spec-sync-graph-codes.test.ts keeps this equal to the table in SPEC-graph-model.md.
export const ERROR_CODES = Object.freeze([
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
] as const);
export type ErrorCode = (typeof ERROR_CODES)[number];

// path is a JSON pointer into the flow
export type ValidationError = { code: ErrorCode; message: string; node?: string; edge?: string; path: string };
export type ParseResult = { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] };
export type ValidationResult = { ok: true; flow: Flow } | { ok: false; errors: ValidationError[] };
