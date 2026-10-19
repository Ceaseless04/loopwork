import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import type { ValidationError } from '../src/types.js';
import { type Rec, validFlow, SRC, SRC_OUT, edit, MAX_ERRORS, outcome, limitError, pointer, TOO_MANY, badEdges } from './parse-helpers.js';

// parseFlow error limit (split from parse.test.ts so the files run in parallel).

describe('T12: bounded work and bounded error count: the error limit', () => {
  it('T12: errors up to the limit are all reported, with no extra error', () => {
    const errors = outcome(badEdges(MAX_ERRORS));
    expect(errors).toHaveLength(MAX_ERRORS);
    expect(errors.some((e) => e.path === '')).toBe(false);
    expect(errors.map((e) => e.path)).toEqual(Array.from({ length: MAX_ERRORS }, (_, i) => `/edges/${i}/to`).sort());
  }, 60_000);

  it('T12: past the error limit the first errors stay, then one limit error at the root, sorted and unique', () => {
    for (const n of [MAX_ERRORS + 1, 400_000]) {
      const errors = outcome(badEdges(n));
      expect(errors).toHaveLength(MAX_ERRORS + 1);
      limitError(errors, TOO_MANY);
      expect(errors[0]?.path).toBe('');
      expect(errors.slice(1).map((e) => e.path)).toEqual(Array.from({ length: MAX_ERRORS }, (_, i) => `/edges/${i}/to`).sort());
      expect(new Set(errors.map((e) => e.path)).size).toBe(errors.length);
    }
  }, 60_000);

  it('T12: 300,000 unknown keys on one object stop at the error limit too', () => {
    const flow: Rec = validFlow();
    for (let i = 0; i < 300_000; i++) flow[`k${i}`] = i;
    const errors = outcome(flow);
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
  }, 60_000);

  it('T12: ordinary error text is free: the limits count values and errors, not the characters of normal paths', () => {
    // a 100-character id and 1,000 errors under it: all kept, no limit error
    const out = { anyOf: Array.from({ length: 1_000 }, () => ({ type: 'x' })) };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { ['n'.repeat(100)]: { kind: 'source', fn: 'g', out } }, edges: [] });
    expect(errors).toHaveLength(1_000);
  });

  it('T12: the first limit wins: the error limit, then more work, is still the error limit', () => {
    // 1,500,000 edges: the 250,001st error stops the parse, but the edges already queued push the work past 5,000,000
    const errors = outcome(badEdges(1_500_000));
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
  }, 60_000);

  it('T12: with the error limit hit, the errors kept are the first in document order', () => {
    const nodes: Rec = {};
    for (let i = 0; i < 300_000; i++) nodes[`n${String(i).padStart(6, '0')}`] = { kind: 'nope' };
    const errors = outcome({ version: 1, id: 'f', name: 'f', nodes, edges: [] });
    expect(errors).toHaveLength(MAX_ERRORS + 1);
    limitError(errors, TOO_MANY);
    expect(errors[1]?.path).toBe('/nodes/n000000/kind');
    expect(errors.at(-1)?.path).toBe(`/nodes/n${String(MAX_ERRORS - 1).padStart(6, '0')}/kind`);
  }, 60_000);

  it('T12: the same order holds for schema properties, list members and JSON values', () => {
    const many = (n: number, bad: unknown): Rec => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(6, '0')}`, bad]));
    const props = outcome(edit(validFlow(), SRC_OUT, { type: 'object', properties: many(MAX_ERRORS + 10, { type: 'x' }) }));
    expect(props[1]?.path).toBe(`${pointer(SRC_OUT)}/properties/k000000/type`);
    const json = outcome(edit(validFlow(), [...SRC, 'params'], Array.from({ length: MAX_ERRORS + 10 }, () => undefined)));
    expect(json[1]?.path).toBe(`${pointer([...SRC, 'params'])}/0`);
  }, 60_000);

  it('T12: a node of unknown kind that holds a flow word reports that key as well as the kind', () => {
    for (const word of ['id', 'version', 'name', 'nodes']) {
      const errors = outcome({ version: 1, id: 'f', name: 'f', nodes: { x: { kind: 'bogus', [word]: 1 } }, edges: [] });
      expect(errors.map((e) => e.path)).toEqual([`/nodes/x/${word}`, '/nodes/x/kind'].sort());
    }
  });

  it('T12: a node whose ownKeys trap throws is E_SHAPE at the node', () => {
    const node = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    const r = parseFlow({ version: 1, id: 'f', name: 'f', nodes: { x: node }, edges: [] });
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.node])).toEqual([['/nodes/x', 'x']]);
  });

  it('T12: a node without kind has a missing kind, an unknown kind is an expected-one-of error', () => {
    const at = (node: Rec): ValidationError[] => outcome({ version: 1, id: 'f', name: 'f', nodes: { x: node }, edges: [] });
    expect(at({})).toMatchObject([{ path: '/nodes/x/kind', message: 'missing field' }]);
    expect(at({ kind: 'bogus' })).toMatchObject([{ path: '/nodes/x/kind', message: expect.stringContaining('expected one of') as unknown }]);
    expect(at({ kind: undefined })).toMatchObject([{ path: '/nodes/x/kind', message: expect.stringContaining('expected one of') as unknown }]);
  });
});
