import { MemoryStore, foldRun } from '@loopwork/eventlog';
import type { Flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun, type RunOutcome } from '../src/index.js';
import { eventsOf, linearFlow, pipelineFlow, startRun } from './helpers.js';

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

async function run(flowDef: Flow, registry = createBuiltins(), o: { store?: MemoryStore; signal?: AbortSignal; flush?: { maxEvents: number; maxMs: number } } = {}) {
  const store = o.store ?? new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', flowDef);
  const outcome: RunOutcome = await executeRun({
    runId: 'r',
    store,
    registry,
    signal: o.signal ?? new AbortController().signal,
    workerId: 'w1',
    expectedSeq,
    ...(o.flush && { flush: o.flush }),
  });
  return { store, outcome, events: await eventsOf(store, 'r') };
}

describe('executeRun failure and cancellation', () => {
  it('EC-9: a failing plain step fails the run with reason step and the node id, its StepFailed is in the log', async () => {
    const registry = createBuiltins();
    registry.map('boom', async (item) => {
      if (item === 4) throw new TypeError('boom at 4');
      return item;
    });
    const { outcome, events } = await run(pipelineFlow({ count: 10, mapFn: 'boom' }), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'm', message: 'boom at 4' });
    const failedAt = events.findIndex((e) => e.type === 'StepFailed');
    expect(events[failedAt]).toMatchObject({
      node: 'm',
      itemId: 'src.out#4',
      attempt: 1,
      willRetry: false,
      error: { name: 'TypeError', message: 'boom at 4' },
    });
    expect(events.slice(0, failedAt).some((e) => e.type === 'StepStarted' && e.node === 'm' && e.itemId === 'src.out#4')).toBe(true);
    expect(events.some((e) => e.type === 'StepSucceeded' && e.node === 'm' && e.itemId === 'src.out#4')).toBe(false);
    // the only RunFailed is the last event, and it follows the StepFailed
    expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'm', message: 'boom at 4' });
    expect(events.filter((e) => e.type === 'RunFailed')).toHaveLength(1);
    expect(events.length - 1).toBeGreaterThan(failedAt);
    // work committed before the failure stays committed
    const committed = events.filter((e) => e.type === 'StepSucceeded' && e.node === 'm').map((e) => (e.type === 'StepSucceeded' ? e.itemId : ''));
    expect(committed).toEqual(['src.out#0', 'src.out#1', 'src.out#2', 'src.out#3']);
    expect(foldRun(events).status).toBe('failed');
  });

  it('execute: a failing sink step logs StepFailed then RunFailed', async () => {
    const registry = createBuiltins();
    registry.sink('boomSink', async (item) => {
      if (item === 2) throw new Error('sink down');
    });
    const { outcome, events } = await run(pipelineFlow({ count: 6, sinkFn: 'boomSink' }), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'snk', message: 'sink down' });
    const failedAt = events.findIndex((e) => e.type === 'StepFailed');
    expect(events[failedAt]).toMatchObject({ node: 'snk', willRetry: false, error: { message: 'sink down' } });
    expect(events.some((e) => e.type === 'StepSucceeded' && e.node === 'snk' && e.itemId.startsWith('src.out#2>'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'snk' });
    expect(events.length - 1).toBeGreaterThan(failedAt);
  });

  it('execute: failEvery fails at the expected item and aborted sibling steps log nothing', async () => {
    const registry = createBuiltins();
    const settled: boolean[] = [];
    // slow upstream map with 4 workers: later items are still in flight when `fe` fails on the third item
    registry.map('slow', async (item, ctx) => {
      try {
        await Promise.race([tick(20), aborted(ctx.signal)]);
        return item;
      } finally {
        settled.push(ctx.signal.aborted);
      }
    });
    const wf = linearFlow({
      source: { fn: 'range', params: { count: 40 } },
      maps: [
        { id: 'a', fn: 'slow', concurrency: 4 },
        { id: 'fe', fn: 'failEvery', params: { n: 3, message: 'every third' } },
      ],
      sink: { fn: 'discard' },
    });
    const { store, outcome, events } = await run(wf, registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'fe', message: 'every third' });
    expect(events.filter((e) => e.type === 'StepFailed')).toHaveLength(1);
    expect(events.find((e) => e.type === 'StepFailed')).toMatchObject({ node: 'fe', itemId: 'src.out#2>a.out#0', willRetry: false });
    expect(events.at(-1)?.type).toBe('RunFailed');

    // runPool waits for the aborted siblings to settle before executeRun returns
    expect(settled).toContain(true);
    expect(await eventsOf(store, 'r')).toHaveLength(events.length);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    expect(await eventsOf(store, 'r')).toHaveLength(events.length);
  });

  it('execute: a failing step aborts siblings itself, without waiting for them to finish', async () => {
    const registry = createBuiltins();
    const siblingSignals: boolean[] = [];
    registry.map('failOrWait', async (item, ctx) => {
      if (item === 0) {
        await tick();
        throw new Error('first fails');
      }
      await aborted(ctx.signal); // only returns once the run aborts this step
      siblingSignals.push(ctx.signal.aborted);
      return item;
    });
    const { outcome, events } = await run(pipelineFlow({ count: 5, mapFn: 'failOrWait', mapConcurrency: 2 }), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'm', message: 'first fails' });
    expect(siblingSignals).toEqual([true]);
    expect(events.at(-1)?.type).toBe('RunFailed');
    expect(events.some((e) => e.type === 'StepSucceeded' && e.node === 'm')).toBe(false); // the released sibling's late result is dropped
  });

  it('execute: a failing source fails the run with reason step and the source node id, nothing is logged after RunFailed', async () => {
    const registry = createBuiltins();
    registry.source('flaky', async function* () {
      yield 0;
      yield 1;
      throw new Error('source down');
    });
    const wf = linearFlow({ source: { fn: 'flaky' }, maps: [{ id: 'm', fn: 'identity' }], sink: { fn: 'discard' } });
    const { outcome, events } = await run(wf, registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'src', message: 'source down' });
    expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'src', message: 'source down' });
    expect(events.filter((e) => e.type === 'RunFailed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'SourceCompleted')).toBe(false);
    expect(foldRun(events).status).toBe('failed');
  });

  it('execute: a failing store append stops the run promptly instead of draining the input', async () => {
    class FlakyStore extends MemoryStore {
      calls = 0;
      override async append(...args: Parameters<MemoryStore['append']>) {
        if (++this.calls > 3) throw new Error('disk full');
        return super.append(...args);
      }
    }
    const registry = createBuiltins();
    let processed = 0;
    registry.map('count', async () => {
      processed++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return []; // nothing reaches the sink, so only the recorder's onError can halt the run
    });
    const flaky = new FlakyStore();
    const outcome = run(pipelineFlow({ count: 5000, mapFn: 'count' }), registry, { store: flaky, flush: { maxEvents: 5, maxMs: 1 } });

    await expect(outcome).rejects.toThrow('disk full');
    expect(processed).toBeLessThan(1000);
  });

  it('execute: a non-Error throw is wrapped: failed outcome and StepFailed carry the string as an Error message', async () => {
    const registry = createBuiltins();
    registry.map('throwStr', async () => {
      throw 'str';
    });
    const { outcome, events } = await run(pipelineFlow({ count: 3, mapFn: 'throwStr' }), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'm', message: 'str' });
    expect(events.find((e) => e.type === 'StepFailed')).toMatchObject({ node: 'm', error: { name: 'Error', message: 'str' } });
  });

  it('execute: aborting opts.signal appends RunCancelled and returns cancelled', async () => {
    const registry = createBuiltins();
    const stepSignals: boolean[] = [];
    registry.map('block', async (item, ctx) => {
      if (typeof item === 'number' && item < 3) return item;
      try {
        await aborted(ctx.signal);
        throw ctx.signal.reason as Error;
      } finally {
        stepSignals.push(ctx.signal.aborted);
      }
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const { store, outcome, events } = await run(pipelineFlow({ count: 50, mapFn: 'block', mapConcurrency: 2 }), registry, { signal: ac.signal });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('RunCancelled');
    expect(events.filter((e) => e.type === 'RunCancelled')).toHaveLength(1);
    expect(events.some((e) => e.type === 'StepFailed' || e.type === 'RunFailed')).toBe(false);
    expect(stepSignals.length).toBeGreaterThan(0);
    expect(stepSignals.every(Boolean)).toBe(true);
    expect(foldRun(events).status).toBe('cancelled');

    expect(await eventsOf(store, 'r')).toHaveLength(events.length);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    expect(await eventsOf(store, 'r')).toHaveLength(events.length);
  });
});
