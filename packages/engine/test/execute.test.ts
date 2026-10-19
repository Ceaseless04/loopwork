import { MemoryStore, foldRun } from '@loopwork/eventlog';
import type { Flow, JsonValue } from '@loopwork/graph';
import { flow } from '@loopwork/graph';
import { describe, expect, it, vi } from 'vitest';
import { createBuiltins, executeRun, type RunOutcome } from '../src/index.js';
import { eventsOf, linearFlow, pipelineFlow, startRun, stepCounts } from './helpers.js';

const WORKER = 'w1';

async function run(
  flowDef: Flow,
  opts: { input?: JsonValue; registry?: ReturnType<typeof createBuiltins>; store?: MemoryStore; expectedSeq?: number; flush?: { maxEvents: number; maxMs: number } } = {},
) {
  const store = opts.store ?? new MemoryStore();
  const expectedSeq = opts.expectedSeq ?? (await startRun(store, 'r', flowDef, opts.input)).expectedSeq;
  const outcome: RunOutcome = await executeRun({
    runId: 'r',
    store,
    registry: opts.registry ?? createBuiltins(),
    signal: new AbortController().signal,
    workerId: WORKER,
    expectedSeq,
    ...(opts.flush && { flush: opts.flush }),
  });
  return { store, outcome, events: await eventsOf(store, 'r') };
}

describe('executeRun', () => {
  it('EC-1: source -> map -> sink over 20 items commits 20 steps per node and the run succeeds', async () => {
    const { outcome, events } = await run(pipelineFlow({ count: 20 }));

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[1]).toMatchObject({ type: 'RunStarted', attempt: 1, workerId: WORKER });
    expect(events.at(-1)?.type).toBe('RunSucceeded');
    expect(stepCounts(events)).toEqual({ m: 20, snk: 20 });
    expect(events.filter((e) => e.type === 'ItemEmitted' && e.node === 'src')).toHaveLength(20);
    expect(events.find((e) => e.type === 'SourceCompleted')).toMatchObject({ node: 'src', count: 20 });

    // a map step is logged as succeeded before its outputs reach the sink
    for (const e of events) {
      if (e.type !== 'StepStarted' || e.node !== 'snk') continue;
      const producer = events.find((p) => p.type === 'StepSucceeded' && p.node === 'm' && p.outputs.some((o) => o.itemId === e.itemId));
      expect(producer?.seq).toBeLessThan(e.seq);
    }

    const state = foldRun(events);
    expect(state.status).toBe('succeeded');
    expect(state.edges.size).toBe(2);
    for (const c of state.edges.values()) expect(c).toEqual({ emitted: 20, consumed: 20 });
  });

  it('map output item ids follow ${inputItemId}>${node}.out#0', async () => {
    const { events } = await run(pipelineFlow({ count: 3 }));
    const ids = events.flatMap((e) => (e.type === 'StepSucceeded' && e.node === 'm' ? e.outputs.map((o) => o.itemId) : []));
    expect(ids.sort()).toEqual(['src.out#0>m.out#0', 'src.out#1>m.out#0', 'src.out#2>m.out#0']);
  });

  it('an array map output fans out as #0..#k-1 and downstream sees all of them', async () => {
    const registry = createBuiltins();
    registry.map('triple', async (item) => [item, item, item]);
    const { outcome, events } = await run(pipelineFlow({ count: 2, mapFn: 'triple' }), { registry });

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(stepCounts(events)).toEqual({ m: 2, snk: 6 });
    const first = events.find((e) => e.type === 'StepSucceeded' && e.node === 'm' && e.itemId === 'src.out#0');
    expect(first?.type === 'StepSucceeded' && first.outputs.map((o) => o.itemId)).toEqual([
      'src.out#0>m.out#0',
      'src.out#0>m.out#1',
      'src.out#0>m.out#2',
    ]);
  });

  it('a tag -> increment chain delivers the expected values to the sink', async () => {
    const lines: string[] = [];
    const wf = linearFlow({
      source: { fn: 'range', params: { count: 3 } },
      maps: [
        { id: 'inc1', fn: 'increment', params: { by: 10 } },
        { id: 'inc2', fn: 'increment' },
        { id: 'tag', fn: 'tag', params: { key: 'k', value: 'v' } },
      ],
      sink: { fn: 'logLine' },
    });
    const { outcome } = await run(wf, { registry: createBuiltins({ writeLine: (l) => lines.push(l) }) });

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(lines.sort()).toEqual(['{"value":11,"k":"v"}', '{"value":12,"k":"v"}', '{"value":13,"k":"v"}']);
  });

  it('source fromInput reads the run input from RunCreated', async () => {
    const wf = linearFlow({ source: { fn: 'fromInput' }, maps: [{ id: 'm', fn: 'identity' }], sink: { fn: 'discard' } });
    const { outcome, events } = await run(wf, { input: ['a', 'b', 'c', 'd'] });

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(stepCounts(events)).toEqual({ m: 4, snk: 4 });
  });

  it('a sink step is never flushed in the same batch as its own start (D4: durable before done)', async () => {
    const store = new MemoryStore();
    const batches: string[][] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (id, evs, o) => {
      batches.push(evs.flatMap((e) => (e.type === 'StepStarted' || e.type === 'StepSucceeded') && e.node === 'snk' ? [`${e.type}:${e.itemId}`] : []));
      return append(id, evs, o);
    });
    const { outcome } = await run(pipelineFlow({ count: 5 }), { store, flush: { maxEvents: 1_000_000, maxMs: 1_000_000 } });

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(batches.flat().filter((t) => t.startsWith('StepSucceeded'))).toHaveLength(5);
    for (const b of batches) {
      for (const t of b) if (t.startsWith('StepStarted:')) expect(b).not.toContain(`StepSucceeded:${t.slice('StepStarted:'.length)}`);
    }
  });

  describe('internal guards', () => {
    it('a frame node fails the run as internal', async () => {
      const wf = flow('f', 'F')
        .frame('loop', {
          kind: 'frame',
          frame: 'foreach',
          body: { nodes: {}, edges: [], entry: { node: 'x', port: 'in' }, exit: { node: 'x', port: 'out' } },
          budgets: { maxIterations: 1, maxDurationMs: 1000 },
          concurrency: 1,
          in: {},
          out: {},
        })
        .build();
      const { outcome, events } = await run(wf);

      expect(outcome).toMatchObject({ status: 'failed', reason: 'internal' });
      expect(outcome.status === 'failed' && outcome.message).toMatch(/frame/i);
      expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'internal' });
    });

    it('an unknown fn name fails the run as internal, naming the fn', async () => {
      const { outcome, events } = await run(pipelineFlow({ count: 1, mapFn: 'nope' }));

      expect(outcome).toMatchObject({ status: 'failed', reason: 'internal' });
      expect(outcome.status === 'failed' && outcome.message).toContain('nope');
      expect(events.map((e) => e.type)).toEqual(['RunCreated', 'RunStarted', 'RunFailed']);
      expect(events.at(-1)).toMatchObject({ type: 'RunFailed', message: expect.stringMatching(/"m".*nope/) });
    });

    it('a log that already holds work fails as internal (resume is slice 5)', async () => {
      const wf = pipelineFlow({ count: 2 });
      const store = new MemoryStore();
      await startRun(store, 'r', wf);
      const { lastSeq } = await store.append(
        'r',
        [
          { type: 'RunStarted', workerId: 'old', attempt: 1 },
          { type: 'ItemEmitted', node: 'src', itemId: 'src.out#0', value: 0 },
          { type: 'StepSucceeded', node: 'm', itemId: 'src.out#0', outputs: [] },
        ],
        { expectedSeq: 1 },
      );
      const { outcome } = await run(wf, { store, expectedSeq: lastSeq });

      expect(outcome).toMatchObject({ status: 'failed', reason: 'internal' });
      expect(outcome.status === 'failed' && outcome.message).toMatch(/resume/i);
    });
  });
});
