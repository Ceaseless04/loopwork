import { describe, expect, it } from 'vitest';
import { validateFlow } from '../src/validate.js';
import type { Flow } from '../src/types.js';

const str = { type: 'string' } as const;

describe('GM-2: validateFlow orchestration', () => {
  it('GM-2: validateFlow reports every problem, sorted by path', () => {
    const flow: Flow = {
      version: 1,
      id: 'f',
      name: 'f',
      nodes: {
        'a.b': { kind: 'source', fn: 'f', out: str },
        s: { kind: 'sink', fn: 'f', in: str },
      },
      edges: [
        { from: { node: 'zz', port: 'out' }, to: { node: 's', port: 'in' } },
        { from: { node: 's', port: 'out' }, to: { node: 's', port: 'in' } },
      ],
    };
    const r = validateFlow(flow);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // '/nodes/...' would be emitted before '/edges/...' by a node-first checker; the orchestrator must sort.
    expect(r.errors.map((x) => [x.code, x.path])).toEqual([
      ['E_UNKNOWN_NODE', '/edges/0/from/node'],
      ['E_UNKNOWN_PORT', '/edges/1/from/port'],
      ['E_DUPLICATE_ID', '/nodes/a.b'],
    ]);
  });
});
