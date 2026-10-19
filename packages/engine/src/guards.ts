import type { RunState } from '@loopwork/eventlog';
import type { Flow } from '@loopwork/graph';
import type { NodeRegistry } from './registry.js';

/** Why this log/flow cannot run in this slice (plain flows, fresh logs only), or undefined. */
export function unrunnable(flow: Flow | undefined, state: RunState, registry: NodeRegistry): string | undefined {
  if (!flow) return 'run has no flow';
  for (const [id, n] of Object.entries(flow.nodes)) {
    if (n.kind === 'frame') return `node "${id}" is a frame; frames land in engine-core slices 3-4`;
    if (!registry.has(n.kind, n.fn)) return `node "${id}": unknown ${n.kind} fn "${n.fn}"`;
  }
  const edgeWork = [...state.edges.values()].some((c) => c.emitted > 0);
  const inFlight = [...state.nodes.values()].some((n) => n.inFlight.size > 0);
  if (state.committed.size > 0 || state.sourcesCompleted.size > 0 || edgeWork || inFlight) {
    return 'log already holds work; resume lands in engine-core slice 5';
  }
  return undefined;
}
