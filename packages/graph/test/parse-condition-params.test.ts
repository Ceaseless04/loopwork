import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { type Rec, FE, RT, UN, WH, brief, canon, edit, get, validFlow } from './parse-helpers.js';

// `conditionParams` is optional JSON on while/until only: the predicate's params, same role as `params` on a node.
describe('conditionParams on while/until frames', () => {
  const cp = { path: 'rating', value: 3, list: [1, null, { x: true }] };

  it.each([['while', WH], ['until', UN]])('accepts and preserves it on %s', (_name, at) => {
    const r = parseFlow(edit(validFlow(), [...at, 'conditionParams'], cp));
    expect(r.ok).toBe(true);
    if (r.ok) expect(canon(get(r.flow, [...at, 'conditionParams']))).toStrictEqual(cp);
  });

  it.each([['foreach', FE], ['retry', RT]])('rejects it on %s as an unknown key', (_name, at) => {
    const r = parseFlow(edit(validFlow(), [...at, 'conditionParams'], cp));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(brief(r.errors)).toEqual([{ code: 'E_SHAPE', path: `/${[...at, 'conditionParams'].join('/')}` }]);
  });

  it('rejects a non-JSON value like params, at the offending leaf', () => {
    const r = parseFlow(edit(validFlow(), [...WH, 'conditionParams'], { a: new Date(0) }));
    const viaParams = parseFlow(edit(validFlow(), ['nodes', 'src', 'params'], { a: new Date(0) }));
    expect(r.ok).toBe(false);
    expect(viaParams.ok).toBe(false);
    if (!r.ok && !viaParams.ok) {
      expect(brief(r.errors)).toEqual([{ code: 'E_SHAPE', path: '/nodes/wh/conditionParams/a' }]);
      expect(brief(viaParams.errors)).toEqual([{ code: 'E_SHAPE', path: '/nodes/src/params/a' }]);
    }
  });

  it('is not present on the base flow, so a flow without it parses to an identical flow', () => {
    const r = parseFlow(validFlow());
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.hasOwn(get(r.flow, WH) as Rec, 'conditionParams')).toBe(false);
  });
});
