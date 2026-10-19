import type { JsonValue } from '@loopwork/graph';

export type NodeKind = 'source' | 'map' | 'sink' | 'predicate';

export type StepContext = {
  runId: string;
  node: string;
  itemId: string;
  attempt: number;
  signal: AbortSignal;
  idempotencyKey: string;
  input: JsonValue | undefined;
  now(): number;
  random(): number;
};
export type PredicateContext = { runId: string; node: string; itemId: string; signal: AbortSignal };

export type SourceFn = (ctx: StepContext, params: JsonValue | undefined) => AsyncIterable<JsonValue>;
export type MapFn = (item: JsonValue, ctx: StepContext, params: JsonValue | undefined) => Promise<JsonValue | JsonValue[]>;
export type SinkFn = (item: JsonValue, ctx: StepContext, params: JsonValue | undefined) => Promise<void>;
export type PredicateFn = (state: JsonValue, ctx: PredicateContext, params: JsonValue | undefined) => Promise<boolean>;

interface FnByKind {
  source: SourceFn;
  map: MapFn;
  sink: SinkFn;
  predicate: PredicateFn;
}

export interface NodeRegistry {
  source(name: string, fn: SourceFn): void;
  map(name: string, fn: MapFn): void;
  sink(name: string, fn: SinkFn): void;
  predicate(name: string, fn: PredicateFn): void;
  has(kind: NodeKind, name: string): boolean;
  names(kind: NodeKind): string[];
  get<K extends NodeKind>(kind: K, name: string): FnByKind[K] | undefined;
}

/** A duplicate name for the same kind throws; kinds are separate namespaces. */
export function createRegistry(): NodeRegistry {
  const maps: { [K in NodeKind]: Map<string, FnByKind[K]> } = {
    source: new Map(),
    map: new Map(),
    sink: new Map(),
    predicate: new Map(),
  };
  const register =
    <K extends NodeKind>(kind: K) =>
    (name: string, fn: FnByKind[K]): void => {
      const m: Map<string, FnByKind[K]> = maps[kind];
      if (m.has(name)) throw new Error(`${kind} "${name}" is already registered`);
      m.set(name, fn);
    };
  return {
    source: register('source'),
    map: register('map'),
    sink: register('sink'),
    predicate: register('predicate'),
    has: (kind, name) => maps[kind].has(name),
    names: (kind) => [...maps[kind].keys()],
    get: (kind, name) => maps[kind].get(name) as never,
  };
}
