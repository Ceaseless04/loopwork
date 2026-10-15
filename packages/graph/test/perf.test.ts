import { describe, expect, it } from 'vitest';
import { validateFlow } from '../src/validate.js';
import type { Body, Edge, Flow, FlowNode, Schema } from '../src/types.js';

// GM-8: validating a 5,000-node flow stays under 1 s (guards accidental O(n^2)). The flows are generated here and are fully
// valid, so every checker (structure, cycles, limits, types) does its whole job; generation is not timed.
const int: Schema = { type: 'integer' };
const budgets = { maxIterations: 1000, maxDurationMs: 60_000 };
const map: FlowNode = { kind: 'map', fn: 'f', in: int, out: int };
const wire = (from: string, to: string): Edge => ({ from: { node: from, port: 'out' }, to: { node: to, port: 'in' } });
const body = (nodes: Record<string, FlowNode>, edges: Edge[], entry: string, exit: string): Body => ({
  nodes,
  edges,
  entry: { node: entry, port: 'in' },
  exit: { node: exit, port: 'out' },
});
const single = (): Body => body({ x: map }, [], 'x', 'x');
const chain = (nodes: Record<string, FlowNode>, count: number, prefix: string): Edge[] => {
  const edges: Edge[] = [];
  for (let i = 0; i < count; i++) {
    nodes[`${prefix}${i}`] = map;
    if (i > 0) edges.push(wire(`${prefix}${i - 1}`, `${prefix}${i}`));
  }
  return edges;
};
const countNodes = (nodes: Record<string, FlowNode>): number =>
  Object.values(nodes).reduce((n, node) => n + 1 + (node.kind === 'frame' ? countNodes(node.body.nodes) : 0), 0);

// Best of three: a loaded CI machine can stall one run, but a quadratic validator is slow in all three.
// Stops early once a run is under `limit` ms (limit 0 always runs all three).
function fastest(f: Flow, limit = 1000): number {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= limit; i++) {
    const start = performance.now();
    const r = validateFlow(f);
    best = Math.min(best, performance.now() - start);
    expect(r.ok ? [] : r.errors.slice(0, 3)).toEqual([]);
  }
  return best;
}

describe('GM-8: validation performance', () => {
  it('GM-8: validating a 5,000-node flow completes in under 1 s', () => {
    // src -> m0 -> ... -> m4993 -> foreach -> while -> retry -> sink, each frame with a one-node body.
    const nodes: Record<string, FlowNode> = { src: { kind: 'source', fn: 'f', out: int } };
    const edges = chain(nodes, 4994, 'm');
    edges.unshift(wire('src', 'm0'));
    nodes['each'] = { kind: 'frame', frame: 'foreach', concurrency: 8, budgets, in: int, out: int, body: single() };
    nodes['loop'] = { kind: 'frame', frame: 'while', condition: 'c', budgets, in: int, out: int, body: single() };
    nodes['again'] = {
      kind: 'frame',
      frame: 'retry',
      maxAttempts: 3,
      backoff: { kind: 'fixed', baseMs: 10 },
      onExhausted: 'fail-run',
      budgets,
      in: int,
      out: int,
      body: single(),
    };
    nodes['dst'] = { kind: 'sink', fn: 'f', in: int };
    edges.push(wire('m4993', 'each'), wire('each', 'loop'), wire('loop', 'again'), wire('again', 'dst'));
    const f: Flow = { version: 1, id: 'perf', name: 'perf', nodes, edges };
    expect(countNodes(nodes)).toBeGreaterThanOrEqual(5000);
    expect(fastest(f)).toBeLessThan(1000);
  });

  // One frame whose body is a chain of `n` nodes: the entry-to-exit reachability scan must not be nodes x edges.
  const bodyFlow = (n: number): Flow => {
    const inner: Record<string, FlowNode> = {};
    const innerEdges = chain(inner, n, 'b');
    const nodes: Record<string, FlowNode> = {
      src: { kind: 'source', fn: 'f', out: int },
      big: { kind: 'frame', frame: 'foreach', concurrency: 8, budgets, in: int, out: int, body: body(inner, innerEdges, 'b0', `b${n - 1}`) },
      dst: { kind: 'sink', fn: 'f', in: int },
    };
    expect(countNodes(nodes)).toBeGreaterThanOrEqual(n);
    return { version: 1, id: 'perf-body', name: 'perf-body', nodes, edges: [wire('src', 'big'), wire('big', 'dst')] };
  };

  it('GM-8: validating a frame with a 5,000-node body completes in under 1 s', () => {
    expect(fastest(bodyFlow(5000))).toBeLessThan(1000);
  });

  // 50k is hopeless for a quadratic scan (tens of seconds) but trivial for a linear one; the generous bound tolerates a loaded machine.
  it('GM-8: validating a frame with a 50,000-node body completes in under 8 s', { timeout: 60_000 }, () => {
    expect(fastest(bodyFlow(50_000), 8000)).toBeLessThan(8000);
  });

  // Scale-free guard: 5x the nodes may cost ~5x the time (linear); a quadratic scan costs ~25x. Limit 12 leaves noise headroom.
  it('GM-8: validation time of a chain body scales linearly (10k to 50k nodes)', { timeout: 120_000 }, () => {
    const small = fastest(bodyFlow(10_000), 0);
    const large = fastest(bodyFlow(50_000), 0);
    expect(large / small).toBeLessThan(12);
  });
});
