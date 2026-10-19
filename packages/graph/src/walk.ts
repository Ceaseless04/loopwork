import type { Body, Edge, Flow, FlowNode } from './types.js';

/**
 * JSON-pointer path convention (RFC 6901, `~` as `~0` and `/` as `~1`; fixed here, asserted by every per-code test):
 *   outer scope           ''
 *   body scope            `/nodes/<frameId>/body`    (nested: `/nodes/a/body/nodes/b/body`)
 *   node problem          `<scope>/nodes/<id>`
 *   edge problem          `<scope>/edges/<i>`
 *   edge endpoint problem `<scope>/edges/<i>/from/node`, `.../to/port`, ...
 *   body boundary problem `<scope>/entry/node`, `<scope>/exit/port`, ...
 * Scoped ids join frame ids with '.' (`outer.inner.node`); the outer scope's scopeId is ''.
 */
export type Scope = {
  scopePath: string;
  scopeId: string;
  nodes: Record<string, FlowNode>;
  edges: Edge[];
  depth: number; // outer scope = 0, a frame's body = frame scope + 1
  body?: Body; // absent for the outer scope; carries entry/exit for a body
};

export const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

// Iterative on purpose: nesting depth is data, so recursion would let the input pick the stack depth.
export function* walkScopes(flow: Flow): Iterable<Scope> {
  const stack: Scope[] = [{ scopePath: '', scopeId: '', nodes: flow.nodes, edges: flow.edges, depth: 0 }];
  for (let scope = stack.pop(); scope !== undefined; scope = stack.pop()) {
    yield scope;
    for (const [id, node] of Object.entries(scope.nodes)) {
      if (node.kind !== 'frame') continue;
      stack.push({
        scopePath: `${scope.scopePath}/nodes/${escapePointer(id)}/body`,
        scopeId: scope.scopeId === '' ? id : `${scope.scopeId}.${id}`,
        nodes: node.body.nodes,
        edges: node.body.edges,
        depth: scope.depth + 1,
        body: node.body,
      });
    }
  }
}

export function portsOf(node: FlowNode): { in: boolean; out: boolean; error: boolean } {
  return {
    in: node.kind !== 'source',
    out: node.kind !== 'sink',
    error: node.kind === 'frame' && node.frame === 'retry' && node.onExhausted === 'emit-error',
  };
}
