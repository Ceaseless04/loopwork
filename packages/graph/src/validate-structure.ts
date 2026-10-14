import { edgeId, scopedId } from './ids.js';
import type { Edge, Flow, PortRef, ValidationError } from './types.js';
import { escapePointer, portsOf, walkScopes } from './walk.js';

const MAX_DEPTH = 8;

// E_DUPLICATE_ID, E_UNKNOWN_NODE, E_UNKNOWN_PORT, E_NESTING_DEPTH. Ids are record keys, so a literal duplicate cannot
// exist; E_DUPLICATE_ID covers ids that collide in the scoped-id / edge-id namespace ('.' and '->').
export function checkStructure(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const scope of walkScopes(flow)) {
    const sc = (id: string): string => (scope.scopeId === '' ? id : scopedId(scope.scopeId, id));
    for (const [id, node] of Object.entries(scope.nodes)) {
      const path = `${scope.scopePath}/nodes/${escapePointer(id)}`;
      if (id.includes('.') || id.includes('->')) {
        errors.push({ code: 'E_DUPLICATE_ID', message: `node id "${id}" contains "." or "->", which breaks scoped ids`, node: sc(id), path });
      }
      if (node.kind === 'frame' && scope.depth >= MAX_DEPTH) {
        errors.push({ code: 'E_NESTING_DEPTH', message: `frames nested deeper than ${MAX_DEPTH}`, node: sc(id), path });
      }
    }
    // A ref is checked as: node exists, then port exists (boundary refs also in the right direction).
    const checkRef = (ref: PortRef, path: string, edge: string | undefined, dir: 'in' | 'out' | undefined): void => {
      const target = Object.hasOwn(scope.nodes, ref.node) ? scope.nodes[ref.node] : undefined;
      const at = edge === undefined ? {} : { edge };
      if (target === undefined) {
        errors.push({ code: 'E_UNKNOWN_NODE', message: `unknown node "${ref.node}"`, node: sc(ref.node), ...at, path: `${path}/node` });
        return;
      }
      const ports = portsOf(target);
      const known = ref.port === 'in' || ref.port === 'out' || ref.port === 'error';
      const ok = dir === undefined ? known && ports[ref.port as 'in' | 'out' | 'error'] : ref.port === dir && ports[dir];
      if (!ok) {
        errors.push({ code: 'E_UNKNOWN_PORT', message: `node "${ref.node}" has no port "${ref.port}"`, node: sc(ref.node), ...at, path: `${path}/port` });
      }
    };
    scope.edges.forEach((e, i) => {
      const id = edgeId(scopedEdge(e, sc));
      checkRef(e.from, `${scope.scopePath}/edges/${i}/from`, id, undefined);
      checkRef(e.to, `${scope.scopePath}/edges/${i}/to`, id, undefined);
    });
    if (scope.body !== undefined) {
      checkRef(scope.body.entry, `${scope.scopePath}/entry`, undefined, 'in');
      checkRef(scope.body.exit, `${scope.scopePath}/exit`, undefined, 'out');
    }
  }
  return errors;
}

const scopedEdge = (e: Edge, sc: (id: string) => string): Edge => ({
  from: { node: sc(e.from.node), port: e.from.port },
  to: { node: sc(e.to.node), port: e.to.port },
});
