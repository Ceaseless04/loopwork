import { MemoryStore, foldRun, type LoopworkEvent } from '@loopwork/eventlog';
import type { Flow, Frame } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltins, executeRun, type NodeRegistry, type RunOutcome } from '../src/index.js';
import { eventsOf, foreachFrame, frameFlow, startRun } from './helpers.js';

const withBudget = (frame: Frame, maxDurationMs: number): Frame => ({ ...frame, budgets: { ...frame.budgets, maxDurationMs } });
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve)); // setImmediate is not faked below

/** Real macrotask yields until `cond` holds; a hang fails fast instead of waiting for the test timeout. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Starts the run; `outcome()` is undefined until it settles. `stop` aborts a hung run on cleanup. */
async function start(def: Flow, registry: NodeRegistry) {
  const store = new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', def);
  const ac = new AbortController();
  let settled: RunOutcome | undefined;
  void executeRun({ runId: 'r', store, registry, signal: ac.signal, workerId: 'w1', expectedSeq }).then((o) => (settled = o));
  return { outcome: () => settled, events: () => eventsOf(store, 'r'), stop: () => ac.abort() };
}

/** Waits for a stalled step's signal to abort. */
const untilAborted = (signal: AbortSignal): Promise<void> => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

describe('frame time budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('EC-7: a frame exceeding maxDurationMs ends failed budget with BudgetExceeded time and aborts in-flight step signals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const aborted: boolean[] = [];
    let started = false;
    const registry = createBuiltins();
    // never finishes on its own: ignores time, settles only when its signal aborts
    registry.map('stall', async (item, ctx) => {
      started = true;
      await untilAborted(ctx.signal);
      aborted.push(ctx.signal.aborted);
      return item;
    });
    const run = await start(frameFlow(withBudget(foreachFrame({ concurrency: 1, fn: 'stall' }), 1000)), registry);
    try {
      await until(() => started);
      await vi.advanceTimersByTimeAsync(999);
      await tick();
      expect(run.outcome()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await until(() => run.outcome() !== undefined);
    } finally {
      run.stop();
    }

    expect(run.outcome()).toMatchObject({ status: 'failed', reason: 'budget', node: 'F', message: expect.stringMatching(/maxDurationMs|time budget/i) });
    const events = await run.events();
    const at = events.findIndex((e) => e.type === 'BudgetExceeded');
    expect(events[at]).toMatchObject({ node: 'F', itemId: 'src.out#0', budget: 'time', limit: 1000 });
    expect((events[at] as Extract<LoopworkEvent, { type: 'BudgetExceeded' }>).used).toBeGreaterThanOrEqual(1000);
    expect(events.slice(at + 1)).toMatchObject([{ type: 'RunFailed', reason: 'budget', node: 'F' }]); // nothing else after the breach
    expect(events.filter((e) => e.type === 'IterationEnded' || e.type === 'FrameExited')).toEqual([]);

    await until(() => aborted.length > 0);
    expect(aborted).toEqual([true]);
    expect(foldRun(events).frames.get('F')?.active.get('src.out#0')?.breached).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('frames: an instance within budget clears its timer; a stalled sibling breaches first-wins for the whole run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let started = 0;
    const registry = createBuiltins();
    registry.map('quick', async (item) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return item;
    });
    // item 0 stalls until aborted; every other item finishes after 10 ms of fake time
    registry.map('slow', async (item, ctx) => {
      started++;
      if (ctx.itemId.startsWith('src.out#0')) await untilAborted(ctx.signal);
      else await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return item;
    });

    const ok = await start(frameFlow(withBudget(foreachFrame({ concurrency: 1, fn: 'quick' }), 1000)), registry);
    try {
      await until(() => vi.getTimerCount() > 0);
      await vi.advanceTimersByTimeAsync(10);
      await until(() => ok.outcome() !== undefined);
    } finally {
      ok.stop();
    }
    expect(ok.outcome()).toEqual({ status: 'succeeded' });
    expect((await ok.events()).some((e) => e.type === 'BudgetExceeded')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const two = await start(frameFlow(withBudget(foreachFrame({ concurrency: 2, fn: 'slow' }), 1000), 2), registry);
    try {
      await until(() => started === 2);
      await vi.advanceTimersByTimeAsync(999); // item 1 is done after 10 ms, item 0 is stalled
      await tick();
      expect(two.outcome()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await until(() => two.outcome() !== undefined);
    } finally {
      two.stop();
    }
    expect(two.outcome()).toMatchObject({ status: 'failed', reason: 'budget', node: 'F' });
    const events = await two.events();
    expect(events.filter((e) => e.type === 'BudgetExceeded')).toMatchObject([{ node: 'F', itemId: 'src.out#0', budget: 'time', limit: 1000 }]);
    expect(events.filter((e) => e.type === 'RunFailed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'budget' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
