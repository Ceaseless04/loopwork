import { checkCycles } from './validate-cycles.js';
import { checkLimits } from './validate-limits.js';
import { checkStructure } from './validate-structure.js';
import type { Flow, ValidationError, ValidationResult } from './types.js';

// Ordered checker list; T14..T16 each append one. Errors are concatenated and sorted by path (UTF-16 order, stable).
const checkers: ((flow: Flow) => ValidationError[])[] = [checkStructure, checkCycles, checkLimits];

export function validateFlow(flow: Flow): ValidationResult {
  const errors = checkers.flatMap((check) => check(flow)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return errors.length === 0 ? { ok: true, flow } : { ok: false, errors };
}
