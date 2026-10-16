import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { type Rec, validFlow, SRC, SRC_OUT, get, edit, parsed, MAX_WORK, outcome, limitError, TOO_LARGE, withSamples, lyingLength, dagBomb, withParams, withinSeconds } from './parse-helpers.js';

// parseFlow work limit (split from parse.test.ts so the files run in parallel).

describe('T12: bounded work and bounded error count: the work limit', () => {
  it.each([1e8, 2 ** 32 - 1])('T12: a sparse array of length %s is one work-limit error, not an exception or an abort', (length) => {
    const errors = outcome(withSamples(new Array<unknown>(length)));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 10_000);

  it.each([1e9, 2 ** 53])('T12: a Proxy array that claims length %s is one work-limit error', (length) => {
    for (const input of [edit(validFlow(), ['edges'], lyingLength(length)), withSamples(lyingLength(length)), withSamples([1, lyingLength(length)])]) {
      const errors = outcome(input);
      expect(errors).toHaveLength(1);
      limitError(errors, TOO_LARGE);
    }
  }, 10_000);

  it.each([24, 40])('T12: a shared (DAG) schema %s levels deep is one work-limit error, not an exponential expansion', (levels) => {
    const errors = outcome(dagBomb(levels));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 20_000);

  it('T12: a small shared structure is still fully expanded and valid', () => {
    const copy = parsed(dagBomb(10));
    let depth = 0;
    for (let s = get(copy, SRC_OUT) as Rec; 'anyOf' in s; s = (s['anyOf'] as Rec[])[1] as Rec) depth++;
    expect(depth).toBe(10);
  });

  it('T12: the work limit is exact: 4,999,980 params elements parse, one more is one limit error', () => {
    const under = new Array<number>(MAX_WORK - 20).fill(0);
    const r = parseFlow(withParams(under));
    expect(r.ok).toBe(true);
    if (r.ok) expect(((r.flow.nodes['s'] as Rec)['params'] as unknown[]).length).toBe(under.length);
    under.push(0);
    limitError(outcome(withParams(under)), TOO_LARGE);
    limitError(outcome(withParams(new Array<number>(MAX_WORK).fill(0))), TOO_LARGE);
  }, 60_000);

  it('T12: the work of several values adds up, and a list longer than what is left is refused before any element is read', () => {
    // 4,000,000 of the budget are used by the first source; the second claims 2,000,000 more and must not be read at all
    let indexReads = 0;
    const counting = new Proxy(new Array<number>(2_000_000).fill(0), {
      get: (t, k, r) => {
        if (typeof k === 'string' && /^\d+$/.test(k)) indexReads++;
        return Reflect.get(t, k, r);
      },
    });
    const sources = { a: { kind: 'source', fn: 'g', params: new Array<number>(4_000_000).fill(0), out: {} }, b: { kind: 'source', fn: 'g', params: counting, out: {} } };
    limitError(outcome({ version: 1, id: 'f', name: 'f', nodes: sources, edges: [] }), TOO_LARGE);
    expect(indexReads).toBe(0);
    const shared = new Array<number>(2_000_000).fill(0);
    const sum: Rec = { version: 1, id: 'f', name: 'f', nodes: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { kind: 'source', fn: 'g', params: shared, out: {} }])), edges: [] };
    limitError(outcome(sum), TOO_LARGE);
  }, 60_000);

  it('T12: a limit never hides behind an ok result: even with no other error the result is not ok', () => {
    expect(parseFlow(withSamples(new Array<unknown>(2 ** 32 - 1))).ok).toBe(false);
  }, 20_000);

  it('T12: after the work limit fires nothing more is recorded, not even from the object being read', () => {
    // body.edges trips the limit; the body's missing entry/exit and the frame's missing budgets/in/out come after it
    const frame = { kind: 'frame', frame: 'foreach', body: { nodes: {}, edges: new Array<unknown>(1e8) } };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { fe: frame }, edges: [] });
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 10_000);

  it('T12: a shared (DAG) structure with a 1,000,000-character key is one work-limit error', () => {
    let params: Rec = { ['a'.repeat(1_000_000)]: 1 };
    for (let i = 0; i < 19; i++) params = { a: params, b: params };
    const errors = withinSeconds(5, () => outcome(edit(validFlow(), [...SRC, 'params'], params)));
    expect(errors).toHaveLength(1);
    limitError(errors, TOO_LARGE);
  }, 20_000);

  it('T12: keys up to 256 characters are free: 21,000 keys of 256 characters parse', () => {
    const params = Object.fromEntries(Array.from({ length: 21_000 }, (_, i) => [String(i).padStart(256, 'k'), i]));
    const r = parseFlow(edit(validFlow(), [...SRC, 'params'], params));
    expect(r.ok).toBe(true);
  }, 20_000);
});
