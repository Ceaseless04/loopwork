import { MemoryStore } from '@loopwork/eventlog';
import { flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun } from '../src/index.js';
import { eventsOf, startRun } from './helpers.js';

const any = {};

/** A store whose appends take a macrotask, so a producer that ignores recorder backpressure runs far ahead of it. */
class SlowStore extends MemoryStore {
  appendedEvents = 0;
  override async append(...args: Parameters<MemoryStore['append']>) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const res = await super.append(...args);
    this.appendedEvents += args[1].length;
    return res;
  }
}

describe('executeRun recorder backpressure', () => {
  it('EC-2: a flow with an unconsumed output does not run ahead of the store (bounded queued batches)', async () => {
    const COUNT = 20_000;
    const MAX_EVENTS = 50;
    const store = new SlowStore();
    const registry = createBuiltins();
    let processed = 0;
    let maxOutstanding = 0;
    registry.map('measure', async (item) => {
      processed++;
      // events the engine has logged for the finished items (ItemEmitted, StepStarted, StepSucceeded) minus the ones the store has
      maxOutstanding = Math.max(maxOutstanding, processed * 3 - store.appendedEvents);
      return item;
    });
    // dangling output: m.out has no consumer (allowed by SPEC-graph-model), so nothing downstream throttles the producers
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: COUNT }, out: any })
      .map('m', { fn: 'measure', in: any, out: any })
      .edge('src.out', 'm.in')
      .build();
    const { expectedSeq } = await startRun(store, 'r', def);

    const outcome = await executeRun({
      runId: 'r',
      store,
      registry,
      signal: new AbortController().signal,
      workerId: 'w1',
      expectedSeq,
      flush: { maxEvents: MAX_EVENTS, maxMs: 1000 },
    });

    expect(outcome).toEqual({ status: 'succeeded' });
    const events = await eventsOf(store, 'r');
    expect(events.filter((e) => e.type === 'StepSucceeded')).toHaveLength(COUNT);
    // a few batches in flight at most; unbounded queueing grows this into the tens of thousands
    expect(maxOutstanding, `max outstanding events: ${maxOutstanding}`).toBeLessThanOrEqual(MAX_EVENTS * 6);
  }, 60_000);
});
