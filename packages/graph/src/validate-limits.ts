import { scopedId } from './ids.js';
import type { Flow, ValidationError } from './types.js';
import { escapePointer, walkScopes } from './walk.js';

const posInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;

// E_MISSING_BUDGET, E_MISSING_EXIT, E_BAD_LIMIT. Semantic fields are read defensively: parseFlow lets them be absent
// or out of range. A retry `maxAttempts` below 1 is E_MISSING_EXIT only; absent/non-integer/non-number is E_BAD_LIMIT only.
export function checkLimits(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const scope of walkScopes(flow)) {
    for (const [id, node] of Object.entries(scope.nodes)) {
      const path = `${scope.scopePath}/nodes/${escapePointer(id)}`;
      const scoped = scope.scopeId === '' ? id : scopedId(scope.scopeId, id);
      const add = (code: ValidationError['code'], at: string, message: string): number =>
        errors.push({ code, message, node: scoped, path: `${path}/${at}` });
      const n = node as Record<string, unknown>;
      if (node.kind !== 'frame') {
        if (n.concurrency !== undefined && !posInt(n.concurrency)) add('E_BAD_LIMIT', 'concurrency', 'concurrency must be a positive integer');
        continue;
      }
      const budgets = (n.budgets ?? {}) as Record<string, unknown>;
      for (const field of ['maxIterations', 'maxDurationMs']) {
        if (!posInt(budgets[field])) add('E_MISSING_BUDGET', `budgets/${field}`, `frame budget ${field} must be a positive integer`);
      }
      if (node.frame === 'foreach' && !posInt(n.concurrency)) add('E_BAD_LIMIT', 'concurrency', 'concurrency must be a positive integer');
      if ((node.frame === 'while' || node.frame === 'until') && (typeof n.condition !== 'string' || n.condition === '')) {
        add('E_MISSING_EXIT', 'condition', `${node.frame} frame needs a condition`);
      }
      if (node.frame === 'retry') {
        const attempts = n.maxAttempts;
        if (typeof attempts === 'number' && attempts < 1) add('E_MISSING_EXIT', 'maxAttempts', 'retry maxAttempts must be at least 1');
        else if (!posInt(attempts)) add('E_BAD_LIMIT', 'maxAttempts', 'maxAttempts must be a positive integer');
        const baseMs = ((n.backoff ?? {}) as Record<string, unknown>).baseMs;
        if (typeof baseMs !== 'number' || !Number.isFinite(baseMs) || baseMs < 0) add('E_BAD_LIMIT', 'backoff/baseMs', 'backoff.baseMs must be a non-negative number');
      }
      if (!reachable(node.body)) add('E_MISSING_EXIT', 'body/exit', 'no path from body entry to body exit');
    }
  }
  return errors;
}

// Iterative walk over body edges. An unknown entry/exit node is E_UNKNOWN_NODE's to report, so it counts as reachable here.
function reachable(body: { nodes: Record<string, unknown>; edges: { from: { node: string }; to: { node: string } }[]; entry: { node: string }; exit: { node: string } }): boolean {
  const { entry, exit } = body;
  if (!Object.hasOwn(body.nodes, entry.node) || !Object.hasOwn(body.nodes, exit.node)) return true;
  const seen = new Set([entry.node]);
  const queue = [entry.node];
  for (let cur = queue.pop(); cur !== undefined; cur = queue.pop()) {
    if (cur === exit.node) return true;
    for (const { from, to } of body.edges) {
      if (from.node === cur && !seen.has(to.node)) {
        seen.add(to.node);
        queue.push(to.node);
      }
    }
  }
  return false;
}
