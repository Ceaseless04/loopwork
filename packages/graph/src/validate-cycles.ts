import { scopedId } from './ids.js';
import type { Edge, Flow, ValidationError } from './types.js';
import { walkScopes } from './walk.js';

// Iterative DFS (input chains can be 200k deep). Returns the first cycle found, in edge order, e.g. ['a','b','a'];
// edges touching ids outside nodeIds are ignored (E_UNKNOWN_NODE reports those).
export function findCycle(nodeIds: string[], edges: Edge[]): string[] | undefined {
  const out = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) if (out.has(e.to.node)) out.get(e.from.node)?.push(e.to.node);
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = done
  for (const root of nodeIds) {
    if (state.has(root)) continue;
    const path = [root];
    const next = [0];
    state.set(root, 1);
    while (path.length > 0) {
      const id = path[path.length - 1] as string;
      const to = (out.get(id) as string[])[next[next.length - 1] as number];
      if (to === undefined) {
        state.set(id, 2);
        path.pop();
        next.pop();
        continue;
      }
      next[next.length - 1] = (next[next.length - 1] as number) + 1;
      if (state.get(to) === 1) return [...path.slice(path.indexOf(to)), to];
      if (state.has(to)) continue;
      state.set(to, 1);
      path.push(to);
      next.push(0);
    }
  }
  return undefined;
}

// E_CYCLE: one error per scope, at the scope pointer; a body's cycle is only reported for that body.
export function checkCycles(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const scope of walkScopes(flow)) {
    const cycle = findCycle(Object.keys(scope.nodes), scope.edges);
    if (cycle === undefined) continue;
    const sc = (id: string): string => (scope.scopeId === '' ? id : scopedId(scope.scopeId, id));
    errors.push({ code: 'E_CYCLE', message: `cycle: ${cycle.map(sc).join(' -> ')}`, node: sc(cycle[0] as string), path: scope.scopePath });
  }
  return errors;
}
