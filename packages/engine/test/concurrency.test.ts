import { MemoryStore } from '@loopwork/eventlog';
import type { JsonValue } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun } from '../src/index.js';
import { linearFlow, startRun } from './helpers.js';

const ITEMS = 60;

/** Registers a probe map and sink: every step bumps its node's gauge and the shared one, then yields a few macrotasks so its siblings can start. */
function probes() {
  const total = { cur: 0, peak: 0 };
  const perNode = new Map<string, number>();
  const live = new Map<string, number>();
  const step = async (node: string): Promise<void> => {
    total.peak = Math.max(total.peak, ++total.cur);
    const n = (live.get(node) ?? 0) + 1;
    live.set(node, n);
    perNode.set(node, Math.max(perNode.get(node) ?? 0, n));
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    live.set(node, n - 1);
    total.cur--;
  };
  const registry = createBuiltins();
  registry.map('probe', async (item: JsonValue, ctx) => {
    await step(ctx.node);
    return item;
  });
  registry.sink('probe', (_item, ctx) => step(ctx.node));
  return { registry, total, perNode };
}

async function runProbed(maps: { id: string; concurrency: number }[], sinkConcurrency: number, maxInFlight: number) {
  const { registry, total, perNode } = probes();
  const def = linearFlow({
    source: { fn: 'range', params: { count: ITEMS } },
    maps: maps.map((m) => ({ ...m, fn: 'probe' })),
    sink: { fn: 'probe', concurrency: sinkConcurrency },
  });
  const store = new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', def);
  const outcome = await executeRun({
    runId: 'r',
    store,
    registry,
    signal: new AbortController().signal,
    workerId: 'w1',
    expectedSeq,
    maxInFlight,
  });
  expect(outcome).toEqual({ status: 'succeeded' });
  return { total: total.peak, perNode };
}

describe('executeRun concurrency', () => {
  it('EC-3: a node runs exactly its configured concurrency in parallel, no more', async () => {
    const { perNode } = await runProbed([{ id: 'm', concurrency: 4 }], 1, 100);

    expect(perNode.get('m')).toBe(4);
    expect(perNode.get('snk')).toBe(1);
  });

  it('EC-3: maxInFlight caps the steps in flight across all nodes', async () => {
    const { total, perNode } = await runProbed(
      [
        { id: 'a', concurrency: 4 },
        { id: 'b', concurrency: 4 },
      ],
      4,
      3,
    );

    expect(total).toBe(3);
    for (const peak of perNode.values()) expect(peak).toBeLessThanOrEqual(3);
  });
});
