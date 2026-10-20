import { MemoryStore, foldRun, type LoopworkEvent } from '@loopwork/eventlog';
import { flow, type Flow } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltins, executeRun, type NodeRegistry } from '../src/index.js';
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

  describe('exhaustion', () => {
    const fixed = { kind: 'fixed', baseMs: 1000 } as const;
    const failingB = { b: { kind: 'map', fn: 'failing', in: ANY, out: ANY } } as const;

    /** Fake timers; `delays` are the retry backoff timers armed (budget timers are >= 3_600_000 and excluded). */
    function setup(): { delays: () => number[]; store: MemoryStore } {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      return {
        store: new MemoryStore(),
        delays: () => timeouts.mock.calls.flatMap(([, ms]) => (typeof ms === 'number' && ms >= 1000 && ms < 3_600_000 ? [ms] : [])),
      };
    }

    it('EC-8: retry exhaustion with fail-run fails the run with reason step', async () => {
      const { store, delays } = setup();
      const registry = createBuiltins();
      registry.map('failing', async () => {
        throw new Error('always fails');
      });
      const def = flow('f', 'F')
        .source('src', { fn: 'range', params: { count: 1 }, out: ANY })
        .frame('F', retryFrame({ maxAttempts: 2, backoff: fixed, onExhausted: 'fail-run', nodes: { ...failingB } }))
        .sink('snk', { fn: 'discard', in: ANY })
        .edge('src.out', 'F.in')
        .edge('F.out', 'snk.in')
        .build();
      const { expectedSeq } = await startRun(store, 'r', def);
      const run = executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq });

      await until(() => delays().length === 1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(run).resolves.toEqual({ status: 'failed', reason: 'step', node: 'F.b', message: 'always fails' });

      expect(delays()).toEqual([1000]);
      expect(vi.getTimerCount()).toBe(0);
      const events = await eventsOf(store, 'r');
      const steps = events.filter((e) => e.type === 'StepFailed').map((e) => e.type === 'StepFailed' && [e.node, e.attempt, e.willRetry]);
      expect(steps).toEqual([
        ['F.b', 1, true],
        ['F.b', 2, false],
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'F.b' });
      expect(events.filter((e) => e.type === 'RunFailed')).toHaveLength(1);
      expect(events.findIndex((e) => e.type === 'StepFailed' && !e.willRetry)).toBe(events.length - 2);
      expect(events.some((e) => e.type === 'FrameExited')).toBe(false);
    });

    it('EC-8: retry exhaustion with emit-error logs FrameExited retries-exhausted with an error item, sends it on error and lets the run continue', async () => {
      const { store, delays } = setup();
      const attempts: Record<string, number> = {};
      const okSeen: { itemId: string; value: unknown }[] = [];
      const errSeen: { itemId: string; value: unknown }[] = [];
      const registry = createBuiltins();
      registry.map('failing', async (item, ctx) => {
        if (item !== 0) return item;
        const n = (attempts[ctx.itemId] = (attempts[ctx.itemId] ?? 0) + 1);
        throw new Error(`always fails, attempt ${n}`);
      });
      registry.sink('okSink', async (item, ctx) => {
        okSeen.push({ itemId: ctx.itemId, value: item });
      });
      registry.sink('errSink', async (item, ctx) => {
        errSeen.push({ itemId: ctx.itemId, value: item });
      });
      const def = flow('f', 'F')
        .source('src', { fn: 'range', params: { count: 2 }, out: ANY })
        .frame('F', retryFrame({ maxAttempts: 2, backoff: fixed, onExhausted: 'emit-error', nodes: { ...failingB } }))
        .sink('okSink', { fn: 'okSink', in: ANY })
        .sink('errSink', { fn: 'errSink', in: ANY })
        .edge('src.out', 'F.in')
        .edge('F.out', 'okSink.in')
        .edge('F.error', 'errSink.in')
        .build();
      const { expectedSeq } = await startRun(store, 'r', def);
      const run = executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq });

      await until(() => delays().length === 1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(run).resolves.toEqual({ status: 'succeeded' });
      expect(delays()).toEqual([1000]);
      expect(vi.getTimerCount()).toBe(0);

      const events = await eventsOf(store, 'r');
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

      const ERR_ID = 'src.out#0>F.error#0';
      expect(of('src.out#0').map(tag)).toEqual([
        'FrameEntered:F:retry',
        'IterationStarted:F:1',
        'StepStarted:F.b:1',
        'StepFailed:F.b:1:true',
        'StepStarted:F.b:2',
        'StepFailed:F.b:2:false',
        'IterationEnded:F:1',
        'FrameExited:F:retries-exhausted',
      ]);
      const exited = events.filter((e) => e.type === 'FrameExited');
      expect(exited[0]).toMatchObject({
        node: 'F',
        itemId: 'src.out#0',
        reason: 'retries-exhausted',
        outputs: [{ port: 'error', itemId: ERR_ID, value: { message: 'always fails, attempt 2', item: 0 } }],
      });
      expect(exited[0]?.type === 'FrameExited' && exited[0].outputs).toHaveLength(1);
      expect(of('src.out#0').filter((e) => e.type === 'StepSucceeded')).toEqual([]);

      // the error item reaches the error sink only, after the write-ahead FrameExited
      expect(errSeen).toEqual([{ itemId: ERR_ID, value: { message: 'always fails, attempt 2', item: 0 } }]);
      expect(okSeen).toEqual([{ itemId: 'src.out#1>F.b.out#0', value: 1 }]);
      const exitAt = events.findIndex((e) => e.type === 'FrameExited' && e.itemId === 'src.out#0');
      expect(events.findIndex((e) => e.type === 'StepStarted' && e.node === 'errSink')).toBeGreaterThan(exitAt);

      // item 1 is a clean success, one at a time after item 0's exit
      expect(of('src.out#1').map(tag)).toEqual([
        'FrameEntered:F:retry',
        'IterationStarted:F:1',
        'StepStarted:F.b:1',
        'StepSucceeded',
        'IterationEnded:F:1',
        'FrameExited:F:success',
      ]);
      expect(exited[1]).toMatchObject({ itemId: 'src.out#1', reason: 'success' });
      expect(exited[1]).not.toHaveProperty('outputs');
      expect(events.findIndex((e) => e.type === 'FrameEntered' && e.itemId === 'src.out#1')).toBeGreaterThan(exitAt);

      const state = foldRun(events);
      expect(state.status).toBe('succeeded');
      expect(state.edges.get('F.error->errSink.in')).toEqual({ emitted: 1, consumed: 1 });
      expect(state.frames.get('F')?.exitedCount).toBe(2);
      expect(state.frames.get('F')?.active.size).toBe(0);
      expect(state.nodes.get('F.b')?.inFlight.size).toBe(0);
    });

    /** Runs `def` to its outcome with a hang guard (maxAttempts 1 everywhere, so no backoff timer is ever needed). */
    async function settle(def: Flow, registry: NodeRegistry) {
      const { store } = setup();
      const { expectedSeq } = await startRun(store, 'r', def);
      let outcome: unknown;
      void executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq }).then((o) => (outcome = o));
      await until(() => outcome !== undefined);
      return { outcome, events: await eventsOf(store, 'r') };
    }

    it('EC-8: with several body steps failing in one instance, the first failure message is the one the error item carries', async () => {
      const registry = createBuiltins();
      registry.map('fan', async () => [1, 2]);
      registry.map('failing', async (item) => {
        throw new Error(`boom ${String(item)}`);
      });
      const def = flow('f', 'F')
        .source('src', { fn: 'range', params: { count: 1 }, out: ANY })
        .frame(
          'F',
          retryFrame({
            maxAttempts: 1,
            backoff: fixed,
            onExhausted: 'emit-error',
            nodes: { b: { kind: 'map', fn: 'fan', in: ANY, out: ANY }, c: { kind: 'map', fn: 'failing', in: ANY, out: ANY } },
            edges: [{ from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'in' } }],
            exit: 'c',
          }),
        )
        .sink('snk', { fn: 'discard', in: ANY })
        .sink('errSnk', { fn: 'discard', in: ANY })
        .edge('src.out', 'F.in')
        .edge('F.out', 'snk.in')
        .edge('F.error', 'errSnk.in')
        .build();
      const { outcome, events } = await settle(def, registry);
      expect(outcome).toEqual({ status: 'succeeded' });
      expect(events.filter((e) => e.type === 'StepFailed').map((e) => e.type === 'StepFailed' && e.error.message)).toEqual(['boom 1', 'boom 2']);
      const exited = events.filter((e) => e.type === 'FrameExited');
      expect(exited).toHaveLength(1);
      expect(exited[0]).toMatchObject({ reason: 'retries-exhausted', outputs: [{ port: 'error', value: { message: 'boom 1', item: 0 } }] });
    });

    it('EC-8: a nested retry frame applies its own policy: an inner fail-run overrides the outer emit-error', async () => {
      const registry = createBuiltins();
      registry.map('failing', async () => {
        throw new Error('inner always fails');
      });
      const inner = retryFrame({ maxAttempts: 1, backoff: fixed, onExhausted: 'fail-run', nodes: { ...failingB } });
      const def = flow('f', 'F')
        .source('src', { fn: 'range', params: { count: 1 }, out: ANY })
        .frame('F', retryFrame({ maxAttempts: 1, backoff: fixed, onExhausted: 'emit-error', nodes: { b: inner } }))
        .sink('snk', { fn: 'discard', in: ANY })
        .sink('errSnk', { fn: 'discard', in: ANY })
        .edge('src.out', 'F.in')
        .edge('F.out', 'snk.in')
        .edge('F.error', 'errSnk.in')
        .build();
      const { outcome, events } = await settle(def, registry);
      expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'F.b.b', message: 'inner always fails' });
      expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'F.b.b' });
      expect(events.filter((e) => e.type === 'FrameExited' && e.reason === 'retries-exhausted')).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
