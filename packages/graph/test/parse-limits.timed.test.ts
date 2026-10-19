import { describe, expect, it } from 'vitest';
import { type Rec, validFlow, SRC, SRC_OUT, edit, outcome, limitError, TOO_LARGE, jsonSchemaChain, jsonFrameChain, withinSeconds, expectBoundedText } from './parse-helpers.js';

// parseFlow limits on error text and shared object structures (split from parse.test.ts so the files run in parallel).

describe('T12: bounded work and bounded error count: error text and shared objects', () => {
  it.each([10_000, 30_000])('T12: an error at every level of a %s-deep schema is bounded by the work limit', (depth) => {
    const errors = withinSeconds(5, () => outcome(jsonSchemaChain(depth)));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it.each([10_000, 30_000])('T12: an error at every level of %s nested frames is bounded by the work limit', (depth) => {
    const errors = withinSeconds(5, () => outcome(jsonFrameChain(depth)));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it('T12: a 1,000,000-character id under 1,000 errors is bounded by the work limit', () => {
    const id = 'x'.repeat(1_000_000);
    const out = { anyOf: Array.from({ length: 1_000 }, () => ({ type: 'x' })) };
    const errors = withinSeconds(5, () => outcome({ version: 1, id: 'f', name: 'f', nodes: { [id]: { kind: 'source', fn: 'g', out } }, edges: [] }));
    limitError(errors, TOO_LARGE);
    expectBoundedText(errors);
  }, 20_000);

  it.each([24, 40])('T12: shared object structures %s levels deep (params, schema properties) are one work-limit error', (levels) => {
    let value: unknown = 1;
    let schema: Rec = { type: 'string' };
    for (let i = 0; i < levels; i++) {
      value = { a: value, b: value };
      schema = { type: 'object', properties: { a: schema, b: schema } };
    }
    for (const input of [edit(validFlow(), [...SRC, 'params'], value), edit(validFlow(), SRC_OUT, schema)]) {
      const errors = withinSeconds(8, () => outcome(input));
      expect(errors).toHaveLength(1);
      limitError(errors, TOO_LARGE);
    }
  }, 30_000);
});
