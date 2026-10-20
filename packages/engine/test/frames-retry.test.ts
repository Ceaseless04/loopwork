import { MemoryStore, foldRun, type LoopworkEvent } from '@loopwork/eventlog';
import { flow } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltins, executeRun } from '../src/index.js';
import { backoffMs, sleep } from '../src/frames.js';
import { eventsOf, retryFrame, startRun } from './helpers.js';

const ANY = {};

/** Real macrotask yields (setImmediate is not faked below) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cond()).toBe(true);
}

describe('frames: retry primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('frames: backoffMs and sleep', async () => {
    expect([1, 2, 5].map((a) => backoffMs({ kind: 'fixed', baseMs: 1000 }, a))).toEqual([1000, 1000, 1000]);
    const exp = { kind: 'exponential', baseMs: 1000 } as const;
    expect([1, 2, 3].map((a) => backoffMs(exp, a))).toEqual([1000, 2000, 4000]);
    expect(backoffMs(exp, 20)).toBe(60_000);

    vi.useFakeTimers();
    const ac = new AbortController();
    let done = false;
    const p = sleep(500, ac.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(vi.getTimerCount()).toBe(0);

    const reason = new Error('stop');
    const aborted = sleep(500, ac.signal);
    const rejected = expect(aborted).rejects.toBe(reason);
    ac.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(sleep(500, ac.signal)).rejects.toBe(reason); // already aborted
    expect(vi.getTimerCount()).toBe(0);
  });

  it('EC-8: retry succeeds on attempt k after k-1 failures with the specified backoff delays and re-runs only the failed step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const delays = (): number[] =>
      timeouts.mock.calls.flatMap(([, ms]) => (typeof ms === 'number' && ms >= 1000 && ms < 3_600_000 ? [ms] : []));

    const ITEM0 = 'src.out#0';
    const order: string[] = []; // item 0's `c` attempts and the side branch, in call order
    const calls: Record<string, number> = {}; // `b` calls per item id
    const seen: Record<string, number> = {}; // `c` attempts per item id
    let failedOnce!: () => void;
    const gate = new Promise<void>((resolve) => (failedOnce = resolve));
    const registry = createBuiltins();
    registry.map('stepB', async (item, ctx) => {
      calls[ctx.itemId] = (calls[ctx.itemId] ?? 0) + 1;
      return item;
    });
    registry.map('flakyC', async (item, ctx) => {
      const n = (seen[ctx.itemId] = (seen[ctx.itemId] ?? 0) + 1);
      if (!ctx.itemId.startsWith(ITEM0)) return item;
      order.push(`c${n}`);
      if (n < 3) {
        if (n === 1) failedOnce();
        throw new Error(`flaky c attempt ${n} of ${ctx.itemId}`);
      }
      return item;
    });
    // `late` yields only once c has failed its first attempt, so `mark` needs a global permit while the retry sleeps.
    registry.source('late', async function* () {
      await gate;
      yield 1;
    });
    registry.sink('mark', async () => {
      order.push('mark');
    });

    const body = retryFrame({
      maxAttempts: 3,
      backoff: { kind: 'exponential', baseMs: 1000 },
      nodes: { b: { kind: 'map', fn: 'stepB', in: ANY, out: ANY }, c: { kind: 'map', fn: 'flakyC', in: ANY, out: ANY } },
      edges: [{ from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'in' } }],
      exit: 'c',
    });
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 2 }, out: ANY })
      .frame('F', body)
      .sink('snk', { fn: 'discard', in: ANY })
      .source('src2', { fn: 'late', out: ANY })
      .sink('side', { fn: 'mark', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .edge('src2.out', 'side.in')
      .build();

    const store = new MemoryStore();
    const { expectedSeq } = await startRun(store, 'r', def);
    const run = executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq, maxInFlight: 1 });

    const early: unknown[] = []; // the run must not settle while the retry backs off
    void run.then((o) => early.push(o));

    // attempt 1 failed and the retry is backing off holding no permit: the side branch completes (maxInFlight 1) before attempt 2
    await until(() => order.includes('mark') || early.length > 0);
    expect(early).toEqual([]);
    expect(order).toEqual(['c1', 'mark']);
    await until(() => delays().length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => delays().length === 2);
    expect(order).toEqual(['c1', 'mark', 'c2']);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(run).resolves.toEqual({ status: 'succeeded' });

    expect(delays()).toEqual([1000, 2000]);
    expect(order).toEqual(['c1', 'mark', 'c2', 'c3']);
    expect(vi.getTimerCount()).toBe(0);

    const events = await eventsOf(store, 'r');
    expect(foldRun(events).status).toBe('succeeded');
    expect(events.filter((e) => e.type === 'StepFailed' && !e.willRetry)).toEqual([]);

    // only the failed step re-runs: b ran once per item, c three times for item 0 and once for item 1
    expect(calls).toEqual({ 'src.out#0': 1, 'src.out#1': 1 });
    const B0 = `${ITEM0}>F.b.out#0`;
    const B1 = 'src.out#1>F.b.out#0';
    expect(seen).toEqual({ [B0]: 3, [B1]: 1 });

    const tag = (e: LoopworkEvent): string => {
      if (e.type === 'IterationStarted' || e.type === 'IterationEnded') return `${e.type}:${e.node}:${e.iteration}`;
      if (e.type === 'FrameEntered') return `${e.type}:${e.node}:${e.frame}`;
      if (e.type === 'FrameExited') return `${e.type}:${e.node}:${e.reason}`;
      if (e.type === 'StepStarted') return `${e.type}:${e.node}:${e.attempt}`;
      if (e.type === 'StepFailed') return `${e.type}:${e.node}:${e.attempt}:${e.willRetry}`;
      return e.type;
    };
    const kinds = new Set(['FrameEntered', 'IterationStarted', 'IterationEnded', 'FrameExited', 'StepStarted', 'StepSucceeded', 'StepFailed']);
    const of = (id: string): LoopworkEvent[] =>
      events.filter((e) => kinds.has(e.type) && 'itemId' in e && e.itemId.startsWith(id) && 'node' in e && e.node.startsWith('F'));
    expect(of(ITEM0).map(tag)).toEqual([
      'FrameEntered:F:retry',
      'IterationStarted:F:1',
      'StepStarted:F.b:1',
      'StepSucceeded',
      'StepStarted:F.c:1',
      'StepFailed:F.c:1:true',
      'StepStarted:F.c:2',
      'StepFailed:F.c:2:true',
      'StepStarted:F.c:3',
      'StepSucceeded',
      'IterationEnded:F:1',
      'FrameExited:F:success',
    ]);
    const failed = of(ITEM0).filter((e) => e.type === 'StepFailed');
    expect(failed.map((e) => e.type === 'StepFailed' && e.error)).toEqual([
      expect.objectContaining({ name: 'Error', message: `flaky c attempt 1 of ${B0}` }),
      expect.objectContaining({ name: 'Error', message: `flaky c attempt 2 of ${B0}` }),
    ]);
    expect(of('src.out#1').map(tag)).toEqual([
      'FrameEntered:F:retry',
      'IterationStarted:F:1',
      'StepStarted:F.b:1',
      'StepSucceeded',
      'StepStarted:F.c:1',
      'StepSucceeded',
      'IterationEnded:F:1',
      'FrameExited:F:success',
    ]);
    // instances of a retry frame run one at a time
    const at = (type: string, id: string): number => events.findIndex((e) => e.type === type && 'itemId' in e && e.itemId === id && 'node' in e && e.node === 'F');
    expect(at('FrameExited', ITEM0)).toBeGreaterThan(-1);
    expect(at('FrameEntered', 'src.out#1')).toBeGreaterThan(at('FrameExited', ITEM0));

    // each item reaches the downstream sink exactly once under its body output id
    const sunk = events.flatMap((e) => (e.type === 'StepStarted' && e.node === 'snk' ? [e.itemId] : []));
    expect(sunk.sort()).toEqual([`${B0}>F.c.out#0`, `${B1}>F.c.out#0`]);
  });
});
