import { validateFlow } from '../src/validate.js';
import type { Body, Edge, Flow, FlowNode, PortSpec } from '../src/types.js';

type Scoped = { nodes: Record<string, FlowNode>; edges: Edge[] };

// Completes the wiring of a fixture: for every map/sink/frame in any scope that has no incoming edge, adds a source node
// (`feed<N>`, output schema = the target's input schema, so no type mismatch) and an edge into it, appended AFTER the existing
// edges so asserted `/edges/N` paths do not move. A body's entry node is fed by the frame boundary and is left alone.
// Lets older per-code fixtures stay focused on the one problem they test without tripping E_UNCONNECTED_PORT.
function wireScope(scope: Scoped, entry?: string): Scoped {
  const fed = new Set(scope.edges.filter((e) => e.to.port === 'in').map((e) => e.to.node));
  const nodes: Record<string, FlowNode> = {};
  const edges = [...scope.edges];
  let n = 0;
  for (const [id, node] of Object.entries(scope.nodes)) {
    nodes[id] = node.kind === 'frame' ? { ...node, body: wireBody(node.body) } : node;
    if (node.kind === 'source' || fed.has(id) || id === entry) continue;
    const feed = `feed${n++}`;
    nodes[feed] = { kind: 'source', fn: 'f', out: (node.in ?? {}) as PortSpec };
    edges.push({ from: { node: feed, port: 'out' }, to: { node: id, port: 'in' } });
  }
  return { nodes, edges };
}

const wireBody = (body: Body): Body => ({ ...body, ...wireScope(body, body.entry.node) });

export const wired = (flow: Flow): Flow => ({ ...flow, ...wireScope(flow) });

export const validateWired = (flow: Flow) => validateFlow(wired(flow));
