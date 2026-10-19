import type { Edge, Flow, FlowNode, JsonValue } from '@loopwork/graph';
import type { LoopworkEvent, RunStatus } from './events.js';
import { nextStatus } from './status.js';

type Counter = { emitted: number; consumed: number };

export type RunState = {
  status: RunStatus;
  flow?: Flow;
  lastSeq: number;
  attempt: number; // highest RunStarted.attempt seen
  failure?: { reason: 'step' | 'budget' | 'crash-loop' | 'internal'; message: string; node?: string | undefined };
  nodes: Map<string, { started: number; succeeded: number; failed: number; inFlight: Set<string> }>;
  edges: Map<string, Counter>; // keyed by edge id over the flattened scoped edges
  frames: Map<
    string,
    { iterationsStarted: number; iterationsEnded: number; active: Set<string>; elapsedMs: number; exited: boolean }
  >;
  sourcesCompleted: Set<string>;
  committed: Set<string>; // `${node}\u0000${itemId}` per StepSucceeded
  recentErrors: { seq: number; node: string; itemId: string; attempt: number; error: { name: string; message: string; stack?: string } }[]; // latest 50
  sideEffects: Map<string, JsonValue>;
};

const MAX_RECENT_ERRORS = 50;

export function emptyRunState(): RunState {
  return {
    status: 'queued',
    lastSeq: 0,
    attempt: 0,
    nodes: new Map(),
    edges: new Map(),
    frames: new Map(),
    sourcesCompleted: new Set(),
    committed: new Set(),
    recentErrors: [],
    sideEffects: new Map(),
  };
}

export function statusOf(state: RunState): RunStatus {
  return state.status;
}

// JSON of the triple: unambiguous for any strings, so (a.b, c) never collides with (a, b.c).
export function sideEffectKey(node: string, itemId: string, key: string): string {
  return JSON.stringify([node, itemId, key]);
}

// Per-run lookup so each event costs O(edges of one endpoint), not O(all edges).
// endpoint `node.port` -> the edges leaving it (sharing the counters held in state.edges).
// `silent` entries only take part in consumption (a while/until body exit is not an emission on the frame's `out`).
type Lookup = Map<string, { to: string; counter: Counter; silent: boolean }[]>;
const lookups = new WeakMap<RunState, Lookup>();

// Edge id format is defined in SPEC-graph-model.md; @loopwork/graph's edgeId is not importable at runtime here.
const edgeId = (e: Edge): string => `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`;

type FrameRef = { id: string; exit: string; silent: boolean };

// Registers the scope's edges (reusing counters already in state.edges) and collects frames outermost-first.
function indexScope(state: RunState, lookup: Lookup, frames: FrameRef[], nodes: Record<string, FlowNode>, edges: Edge[], prefix: string): void {
  for (const { from, to } of edges) {
    const scoped = { from: { node: prefix + from.node, port: from.port }, to: { node: prefix + to.node, port: to.port } };
    const id = edgeId(scoped);
    let counter = state.edges.get(id);
    if (!counter) state.edges.set(id, (counter = { emitted: 0, consumed: 0 }));
    const key = `${scoped.from.node}.${scoped.from.port}`;
    const list = lookup.get(key) ?? [];
    list.push({ to: scoped.to.node, counter, silent: false });
    lookup.set(key, list);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind !== 'frame') continue;
    const frame = prefix + id;
    const exit = `${frame}.${node.body.exit.node}.${node.body.exit.port}`;
    frames.push({ id: frame, exit, silent: node.frame === 'while' || node.frame === 'until' });
    indexScope(state, lookup, frames, node.body.nodes, node.body.edges, `${frame}.`);
  }
}

function buildLookup(state: RunState, flow: Flow): Lookup {
  const lookup: Lookup = new Map();
  const frames: FrameRef[] = [];
  indexScope(state, lookup, frames, flow.nodes, flow.edges, '');
  // The body exit endpoint feeds whatever the frame's `out` feeds. Outermost-first, so an outer alias is already on
  // `inner.out` when the inner frame aliases its own exit: nested exits resolve transitively.
  for (const { id, exit, silent } of frames) {
    const outs = lookup.get(`${id}.out`);
    if (!outs) continue;
    lookup.set(exit, [...(lookup.get(exit) ?? []), ...(silent ? outs.map((o) => ({ ...o, silent: true })) : outs)]);
  }
  return lookup;
}

// itemIds encode their producer (SPEC-event-log.md): `src.out#0`, `${input}>${node}.${port}#${k}`.
function producerOf(itemId: string): string {
  const seg = itemId.slice(itemId.lastIndexOf('>') + 1);
  const hash = seg.lastIndexOf('#');
  return hash < 0 ? seg : seg.slice(0, hash);
}

function consume(lookup: Lookup | undefined, node: string, itemId: string): void {
  for (const edge of lookup?.get(producerOf(itemId)) ?? []) if (edge.to === node) edge.counter.consumed++;
}

function emit(lookup: Lookup | undefined, endpoint: string): void {
  for (const edge of lookup?.get(endpoint) ?? []) if (!edge.silent) edge.counter.emitted++;
}

function nodeOf(state: RunState, id: string) {
  let n = state.nodes.get(id);
  if (!n) state.nodes.set(id, (n = { started: 0, succeeded: 0, failed: 0, inFlight: new Set() }));
  return n;
}

function frameOf(state: RunState, id: string) {
  let f = state.frames.get(id);
  if (!f) {
    state.frames.set(id, (f = { iterationsStarted: 0, iterationsEnded: 0, active: new Set(), elapsedMs: 0, exited: false }));
  }
  return f;
}

// Mutates and returns `state`.
export function applyEvent(state: RunState, e: LoopworkEvent): RunState {
  state.status = nextStatus(state.status, e);
  state.lastSeq = e.seq;
  let lookup = lookups.get(state);
  if (!lookup && state.flow) lookups.set(state, (lookup = buildLookup(state, state.flow))); // e.g. a structuredClone'd state
  switch (e.type) {
    case 'RunCreated': {
      state.flow = e.flow;
      lookups.set(state, buildLookup(state, e.flow));
      break;
    }
    case 'RunStarted':
      state.attempt = Math.max(state.attempt, e.attempt);
      delete state.failure; // a resume reopens a failed run
      break;
    case 'RunFailed':
      state.failure = { reason: e.reason, message: e.message, node: e.node };
      break;
    case 'ItemEmitted':
      emit(lookup, `${e.node}.out`);
      break;
    case 'SourceCompleted':
      state.sourcesCompleted.add(e.node);
      break;
    case 'StepStarted': {
      const n = nodeOf(state, e.node);
      n.started++;
      n.inFlight.add(e.itemId);
      if (e.attempt === 1) consume(lookup, e.node, e.itemId); // re-runs do not consume again
      break;
    }
    case 'StepSucceeded': {
      const n = nodeOf(state, e.node);
      n.succeeded++;
      n.inFlight.delete(e.itemId);
      state.committed.add(`${e.node}\u0000${e.itemId}`);
      for (const o of e.outputs) emit(lookup, `${e.node}.${o.port}`);
      break;
    }
    case 'StepFailed': {
      const n = nodeOf(state, e.node);
      n.failed++;
      n.inFlight.delete(e.itemId);
      state.recentErrors.push({ seq: e.seq, node: e.node, itemId: e.itemId, attempt: e.attempt, error: e.error });
      if (state.recentErrors.length > MAX_RECENT_ERRORS) state.recentErrors.shift();
      break;
    }
    case 'SideEffect':
      state.sideEffects.set(sideEffectKey(e.node, e.itemId, e.key), e.value);
      break;
    case 'FrameEntered':
      frameOf(state, e.node).active.add(e.itemId);
      consume(lookup, e.node, e.itemId);
      break;
    case 'IterationStarted':
      frameOf(state, e.node).iterationsStarted++;
      break;
    case 'IterationEnded': {
      const f = frameOf(state, e.node);
      f.iterationsEnded++;
      f.elapsedMs += e.elapsedMs;
      break;
    }
    case 'FrameExited': {
      const f = frameOf(state, e.node);
      f.active.delete(e.itemId);
      f.exited = true;
      if (e.reason === 'condition') emit(lookup, `${e.node}.out`); // while/until emit only their final state
      break;
    }
    default:
      break;
  }
  return state;
}

export function foldRun(events: Iterable<LoopworkEvent>): RunState {
  const state = emptyRunState();
  for (const e of events) applyEvent(state, e);
  return state;
}
