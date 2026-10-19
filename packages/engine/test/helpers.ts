import type { EventStore, LoopworkEvent, MemoryStore } from '@loopwork/eventlog';
import { flow, type Flow, type JsonValue } from '@loopwork/graph';

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
