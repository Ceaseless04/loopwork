import type { RunState } from '@loopwork/eventlog';
import type { Flow, FlowNode } from '@loopwork/graph';
import type { NodeRegistry } from './registry.js';

/** First node (walking frame bodies; ids are scoped like `F.b`) this slice cannot run: unknown fns, unregistered while/until predicates, sources in frame bodies. */
function badNode(nodes: Record<string, FlowNode>, prefix: string, registry: NodeRegistry): string | undefined {
  for (const [id, n] of Object.entries(nodes)) {
    const sid = `${prefix}${id}`;
    if (n.kind === 'frame') {
      if ((n.frame === 'while' || n.frame === 'until') && !registry.has('predicate', n.condition)) return `node "${sid}": unknown predicate "${n.condition}"`;
      const bad = badNode(n.body.nodes, `${sid}.`, registry);
      if (bad !== undefined) return bad;
    } else if (prefix !== '' && n.kind === 'source') {
      return `node "${sid}" is a source; a source in a frame body is not supported`;
    } else if (!registry.has(n.kind, n.fn)) return `node "${sid}": unknown ${n.kind} fn "${n.fn}"`;
  }
  return undefined;
}

/** Why this log/flow cannot run in this slice (plain flows, fresh logs only), or undefined. */
export function unrunnable(flow: Flow | undefined, state: RunState, registry: NodeRegistry): string | undefined {
  if (!flow) return 'run has no flow';
  const bad = badNode(flow.nodes, '', registry);
  if (bad !== undefined) return bad;
  const edgeWork = [...state.edges.values()].some((c) => c.emitted > 0);
  const inFlight = [...state.nodes.values()].some((n) => n.inFlight.size > 0);
  if (state.committed.size > 0 || state.sourcesCompleted.size > 0 || edgeWork || inFlight) {
    return 'log already holds work; resume lands in engine-core slice 5';
  }
  return undefined;
}
