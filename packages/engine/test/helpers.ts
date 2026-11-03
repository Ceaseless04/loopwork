import type { EventStore, LoopworkEvent, MemoryStore } from '@loopwork/eventlog';
import { flow, type Edge, type Flow, type FlowNode, type Frame, type JsonValue } from '@loopwork/graph';

const any = {};

type Stage = { fn: string; params?: JsonValue; concurrency?: number };

/** `src -> <maps in order> -> snk`; map ids are given, source and sink are always `src` and `snk`. */
export function linearFlow(o: { source: { fn: string; params?: JsonValue }; maps: (Stage & { id: string })[]; sink: Stage }): Flow {
  const b = flow('f', 'F').source('src', { ...o.source, out: any });
  let prev = 'src';
  for (const { id, ...m } of o.maps) {
    b.map(id, { ...m, in: any, out: any }).edge(`${prev}.out`, `${id}.in`);
    prev = id;
  }
  return b.sink('snk', { ...o.sink, in: any }).edge(`${prev}.out`, 'snk.in').build();
}

/** `src(range count) -> m -> snk` */
export function pipelineFlow(o: {
  mapFn?: string;
  mapParams?: JsonValue;
  mapConcurrency?: number;
  sinkFn?: string;
  sinkConcurrency?: number;
  count: number;
}): Flow {
  return linearFlow({
    source: { fn: 'range', params: { count: o.count } },
    maps: [
      {
        id: 'm',
        fn: o.mapFn ?? 'identity',
        ...(o.mapParams !== undefined && { params: o.mapParams }),
        ...(o.mapConcurrency !== undefined && { concurrency: o.mapConcurrency }),
      },
    ],
    sink: { fn: o.sinkFn ?? 'discard', ...(o.sinkConcurrency !== undefined && { concurrency: o.sinkConcurrency }) },
  });
}

/** A foreach frame whose body is `nodes` (default: one map `b`, fn `fn`, entry `b.in`, exit `b.out`). */
export function foreachFrame(o: {
  concurrency: number;
  fn?: string;
  nodes?: Record<string, FlowNode>;
  edges?: Edge[];
  entry?: string;
  exit?: string;
}): Frame {
  return {
    kind: 'frame',
    frame: 'foreach',
    body: {
      nodes: o.nodes ?? { b: { kind: 'map', fn: o.fn ?? 'identity', in: any, out: any } },
      edges: o.edges ?? [],
      entry: { node: o.entry ?? 'b', port: 'in' },
      exit: { node: o.exit ?? 'b', port: 'out' },
    },
    budgets: { maxIterations: 1, maxDurationMs: 600_000 },
    concurrency: o.concurrency,
    in: any,
    out: any,
  };
}

type RetryFrame = Extract<Frame, { frame: 'retry' }>;

/** A retry frame whose body is `nodes` (default: one map `b`, identity; entry `b.in`, exit `<exit>.out`, default `b`). */
export function retryFrame(o: {
  maxAttempts: number;
  backoff: RetryFrame['backoff'];
  onExhausted?: RetryFrame['onExhausted'];
  nodes?: Record<string, FlowNode>;
  edges?: Edge[];
  exit?: string;
}): Frame {
  return {
    kind: 'frame',
    frame: 'retry',
    body: {
      nodes: o.nodes ?? { b: { kind: 'map', fn: 'identity', in: any, out: any } },
      edges: o.edges ?? [],
      entry: { node: 'b', port: 'in' },
      exit: { node: o.exit ?? 'b', port: 'out' },
    },
    budgets: { maxIterations: 1, maxDurationMs: 3_600_000 },
    maxAttempts: o.maxAttempts,
    backoff: o.backoff,
    onExhausted: o.onExhausted ?? 'fail-run',
    in: any,
    out: any,
  };
}

/** A while/until frame whose body is `nodes` (default: one map `b`, fn `fn` (identity) with `fnParams`; entry `<entry>.in`, exit `<exit>.out`, both default `b`). */
export function loopFrame(o: {
  frame: 'while' | 'until';
  condition: string;
  conditionParams?: JsonValue;
  maxIterations: number;
  maxDurationMs?: number;
  fn?: string;
  fnParams?: JsonValue;
  nodes?: Record<string, FlowNode>;
  edges?: Edge[];
  entry?: string;
  exit?: string;
}): Frame {
  return {
    kind: 'frame',
    frame: o.frame,
    body: {
      nodes: o.nodes ?? { b: { kind: 'map', fn: o.fn ?? 'identity', ...(o.fnParams !== undefined && { params: o.fnParams }), in: any, out: any } },
      edges: o.edges ?? [],
      entry: { node: o.entry ?? 'b', port: 'in' },
      exit: { node: o.exit ?? 'b', port: 'out' },
    },
    budgets: { maxIterations: o.maxIterations, maxDurationMs: o.maxDurationMs ?? 3_600_000 },
    condition: o.condition,
    ...(o.conditionParams !== undefined && { conditionParams: o.conditionParams }),
    in: any,
    out: any,
  };
}

/** `src(range count) -> F -> snk` around the given frame. */
export function frameFlow(frame: Frame, count = 1): Flow {
  return flow('f', 'F')
    .source('src', { fn: 'range', params: { count }, out: any })
    .frame('F', frame)
    .sink('snk', { fn: 'discard', in: any })
    .edge('src.out', 'F.in')
    .edge('F.out', 'snk.in')
    .build();
}

/** Creates the run (RunCreated is seq 1), so the first engine append expects seq 1. */
export async function startRun(store: MemoryStore, runId: string, flowDef: Flow, input?: JsonValue): Promise<{ expectedSeq: number }> {
  await store.create(runId, { type: 'RunCreated', flow: flowDef, ...(input !== undefined && { input }), createdBy: 'cli' });
  return { expectedSeq: 1 };
}

export async function eventsOf(store: EventStore, runId: string): Promise<LoopworkEvent[]> {
  const out: LoopworkEvent[] = [];
  for await (const e of store.read(runId)) out.push(e);
  return out;
}

/** StepSucceeded count per node. */
export function stepCounts(events: LoopworkEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) if (e.type === 'StepSucceeded') counts[e.node] = (counts[e.node] ?? 0) + 1;
  return counts;
}
