import type { Edge, Flow, FlowNode, Frame, PortRef } from './types.js';

type Spec<K extends 'source' | 'map' | 'sink'> = Omit<Extract<FlowNode, { kind: K }>, 'kind'>;

// edge() takes plain strings (not `${string}.${string}`) because the builder never rejects a dotless one.
// Split at the LAST '.': node ids may be scoped ("loop.a"), ports never contain '.'.
// A string with no '.' is not rejected (the builder never validates): it yields an empty port.
function ref(s: string): PortRef {
  const i = s.lastIndexOf('.');
  return i < 0 ? { node: s, port: '' } : { node: s.slice(0, i), port: s.slice(i + 1) };
}

export interface FlowBuilder {
  source(id: string, spec: Spec<'source'>): FlowBuilder;
  map(id: string, spec: Spec<'map'>): FlowBuilder;
  sink(id: string, spec: Spec<'sink'>): FlowBuilder;
  frame(id: string, frame: Frame): FlowBuilder;
  edge(from: string, to: string): FlowBuilder;
  build(): Flow;
}

export function flow(id: string, name: string): FlowBuilder {
  const nodes: Record<string, FlowNode> = {};
  const edges: Edge[] = [];
  const b: FlowBuilder = {
    source: (nid, spec) => ((nodes[nid] = { kind: 'source', ...spec }), b),
    map: (nid, spec) => ((nodes[nid] = { kind: 'map', ...spec }), b),
    sink: (nid, spec) => ((nodes[nid] = { kind: 'sink', ...spec }), b),
    frame: (nid, frame) => ((nodes[nid] = frame), b),
    edge: (from, to) => (edges.push({ from: ref(from), to: ref(to) }), b),
    // Flow is plain JSON data, so a JSON round-trip is a deep copy (structuredClone is not typed under `types: []`).
    build: () => JSON.parse(JSON.stringify({ version: 1, id, name, nodes, edges })) as Flow,
  };
  return b;
}
