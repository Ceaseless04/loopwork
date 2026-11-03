import { MemoryStore, foldRun, type LoopworkEvent } from '@loopwork/eventlog';
import { flow, type Flow, type Frame, type JsonValue } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltins, executeRun, type NodeRegistry, type RunOutcome } from '../src/index.js';
import { eventsOf, foreachFrame, frameFlow, loopFrame, retryFrame, startRun } from './helpers.js';

const ANY = {};
const INC = { by: 1 };
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve)); // setImmediate is not faked below

/** Real macrotask yields until `cond` holds; a hang fails fast instead of waiting for the test timeout. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Built-ins plus numeric-state predicates: `belowN`, `atLeast3`, and the constants `always` / `never`. */
function loopRegistry(): NodeRegistry {
  const r = createBuiltins();
  const below = (n: number) => async (s: JsonValue) => typeof s === 'number' && s < n;
  r.predicate('below2', below(2));
  r.predicate('below3', below(3));
  r.predicate('below2000', below(2000));
  r.predicate('atLeast3', async (s) => typeof s === 'number' && s >= 3);
  r.predicate('always', async () => true);
  r.predicate('never', async () => false);
  return r;
}

/** Runs to the outcome; a run that never settles resolves as `hung` after 3 s instead of waiting for the test timeout. */
async function exec(def: Flow, registry: NodeRegistry) {
  const store = new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', def);
  const run = executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ status: 'hung' }>((resolve) => (timer = setTimeout(() => resolve({ status: 'hung' }), 3000)));
  const outcome = await Promise.race([run, hung]);
  clearTimeout(timer);
  return { outcome, events: await eventsOf(store, 'r') };
}

/** Starts the run with small channels and per-event flushes; `outcome()` is undefined until it settles. `stop` aborts a stuck run on cleanup. */
async function start(def: Flow, registry: NodeRegistry) {
  const store = new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', def);
  const ac = new AbortController();
  let settled: RunOutcome | undefined;
  void executeRun({ runId: 'r', store, registry, signal: ac.signal, workerId: 'w1', expectedSeq, channelCapacity: 1, flush: { maxEvents: 1, maxMs: 1 } }).then((o) => (settled = o));
  return { outcome: () => settled, events: () => eventsOf(store, 'r'), stop: () => ac.abort() };
}

/** A sink `gate` that holds every item until `open()` is called. */
function gatedRegistry(): { registry: NodeRegistry; open(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const registry = loopRegistry();
  registry.sink('gate', () => gate);
  return { registry, open };
}

const withBudget = (frame: Frame, maxDurationMs: number): Frame => ({ ...frame, budgets: { ...frame.budgets, maxDurationMs } });

/** Lifecycle of one frame instance as `Type:detail` tags, in log order. */
function trace(events: LoopworkEvent[], itemId: string, node = 'F'): string[] {
  return events.flatMap((e) => {
    if (!('node' in e) || e.node !== node || !('itemId' in e) || e.itemId !== itemId) return [];
    if (e.type === 'FrameEntered') return [`${e.type}:${e.frame}`];
    if (e.type === 'IterationStarted' || e.type === 'IterationEnded') return [`${e.type}:${e.iteration}`];
    if (e.type === 'FrameExited') return [`${e.type}:${e.reason}`];
    return [];
  });
}

const frameExits = (events: LoopworkEvent[], node = 'F') => events.filter((e) => e.type === 'FrameExited' && e.node === node);
const count = (events: LoopworkEvent[], type: LoopworkEvent['type']): number => events.filter((e) => e.type === type).length;

/** Every frame in the folded state has no live instance left. */
function expectNoActive(events: LoopworkEvent[]): void {
  const frames = [...foldRun(events).frames];
  expect(frames.length).toBeGreaterThan(0);
  for (const [id, f] of frames) expect([id, f.active.size]).toEqual([id, 0]);
}

describe('while/until frames', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('EC-5: a while frame iterates to the condition and emits the final state on out (write-ahead FrameExited, entry ids .iter#n)', async () => {
    const def = frameFlow(loopFrame({ frame: 'while', condition: 'below3', maxIterations: 10, fn: 'increment', fnParams: INC }));
    const { outcome, events } = await exec(def, loopRegistry());

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(trace(events, 'src.out#0')).toEqual([
      'FrameEntered:while',
      'IterationStarted:1',
      'IterationEnded:1',
      'IterationStarted:2',
      'IterationEnded:2',
      'IterationStarted:3',
      'IterationEnded:3',
      'FrameExited:condition',
    ]);
    // each iteration's body runs on the previous state, entered under `${instance}>${frame}.iter#n`
    const started = events.filter((e) => e.type === 'StepStarted' && e.node === 'F.b');
    expect(started.map((e) => e.type === 'StepStarted' && e.itemId)).toEqual([1, 2, 3].map((n) => `src.out#0>F.iter#${n}`));
    const produced = events.filter((e) => e.type === 'StepSucceeded' && e.node === 'F.b');
    expect(produced.map((e) => e.type === 'StepSucceeded' && e.outputs[0]?.value)).toEqual([1, 2, 3]);

    const exits = frameExits(events);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ itemId: 'src.out#0', reason: 'condition', outputs: [{ port: 'out', itemId: 'src.out#0>F.out#0', value: 3 }] });
    const exitAt = events.findIndex((e) => e.type === 'FrameExited');
    const sinkAt = events.findIndex((e) => e.type === 'StepStarted' && e.node === 'snk');
    expect(sinkAt).toBeGreaterThan(exitAt); // logged before delivered
    expect(events[sinkAt]).toMatchObject({ itemId: 'src.out#0>F.out#0' });

    const state = foldRun(events);
    expect(state.status).toBe('succeeded');
    expect(state.edges.get('F.out->snk.in')).toEqual({ emitted: 1, consumed: 1 });
    expect(state.frames.get('F')?.exitedCount).toBe(1);
    expectNoActive(events);
  });

  it('EC-5: an until frame always runs the body at least once and checks the condition after each iteration', async () => {
    const already = await exec(frameFlow(loopFrame({ frame: 'until', condition: 'always', maxIterations: 10, fn: 'increment', fnParams: INC })), loopRegistry());
    expect(already.outcome).toEqual({ status: 'succeeded' });
    expect(trace(already.events, 'src.out#0')).toEqual(['FrameEntered:until', 'IterationStarted:1', 'IterationEnded:1', 'FrameExited:condition']);
    expect(frameExits(already.events)[0]).toMatchObject({ outputs: [{ port: 'out', itemId: 'src.out#0>F.out#0', value: 1 }] });

    const three = await exec(frameFlow(loopFrame({ frame: 'until', condition: 'atLeast3', maxIterations: 10, fn: 'increment', fnParams: INC })), loopRegistry());
    expect(three.outcome).toEqual({ status: 'succeeded' });
    expect(count(three.events, 'IterationStarted')).toBe(3);
    expect(count(three.events, 'IterationEnded')).toBe(3);
    expect(frameExits(three.events)[0]).toMatchObject({ reason: 'condition', outputs: [{ port: 'out', value: 3 }] });
    expectNoActive(three.events);
  });

  it('EC-5: a while frame whose condition is false initially runs zero iterations and still emits the input state', async () => {
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'while', condition: 'never', maxIterations: 10, fn: 'increment', fnParams: INC })), loopRegistry());

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(trace(events, 'src.out#0')).toEqual(['FrameEntered:while', 'FrameExited:condition']);
    expect(events.some((e) => e.type === 'StepStarted' && e.node === 'F.b')).toBe(false);
    expect(frameExits(events)[0]).toMatchObject({ outputs: [{ port: 'out', itemId: 'src.out#0>F.out#0', value: 0 }] });
    expect(events.filter((e) => e.type === 'StepStarted' && e.node === 'snk')).toMatchObject([{ itemId: 'src.out#0>F.out#0' }]);
    const state = foldRun(events);
    expect(state.edges.get('F.out->snk.in')).toEqual({ emitted: 1, consumed: 1 });
    expectNoActive(events);
  });

  it('EC-5: each input item is its own instance; instances of one frame run one at a time', async () => {
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'while', condition: 'below3', maxIterations: 10, fn: 'increment', fnParams: INC }), 3), loopRegistry());

    expect(outcome).toEqual({ status: 'succeeded' });
    const exits = frameExits(events);
    expect(exits.map((e) => e.type === 'FrameExited' && e.outputs?.map((o) => [o.itemId, o.value]))).toEqual([
      [['src.out#0>F.out#0', 3]],
      [['src.out#1>F.out#0', 3]],
      [['src.out#2>F.out#0', 3]],
    ]);
    expect([0, 1, 2].map((i) => trace(events, `src.out#${i}`).filter((t) => t.startsWith('IterationStarted')).length)).toEqual([3, 2, 1]);
    // strictly sequential: an instance is exited before the next one is entered
    const marks = events.filter((e) => e.type === 'FrameEntered' || e.type === 'FrameExited').map((e) => e.type);
    expect(marks).toEqual(['FrameEntered', 'FrameExited', 'FrameEntered', 'FrameExited', 'FrameEntered', 'FrameExited']);
    expect(foldRun(events).edges.get('F.out->snk.in')).toEqual({ emitted: 3, consumed: 3 });
  });

  it('EC-6: a while whose condition never becomes false ends failed budget with BudgetExceeded iterations and does not hang', async () => {
    const def = frameFlow(loopFrame({ frame: 'while', condition: 'always', maxIterations: 4, fn: 'increment', fnParams: INC }));
    const { outcome, events } = await exec(def, loopRegistry());

    expect(outcome).toMatchObject({ status: 'failed', reason: 'budget', node: 'F', message: expect.stringMatching(/maxIterations|iteration/i) });
    expect(events.filter((e) => e.type === 'IterationStarted').map((e) => e.type === 'IterationStarted' && e.iteration)).toEqual([1, 2, 3, 4]);
    expect(count(events, 'IterationEnded')).toBe(4);
    const at = events.findIndex((e) => e.type === 'BudgetExceeded');
    expect(events.filter((e) => e.type === 'BudgetExceeded')).toHaveLength(1);
    expect(events[at]).toMatchObject({ node: 'F', itemId: 'src.out#0', budget: 'iterations', limit: 4, used: 4 });
    expect(events.slice(at + 1)).toMatchObject([{ type: 'RunFailed', reason: 'budget', node: 'F' }]);
    expect(frameExits(events)).toEqual([]);
    expect(foldRun(events).frames.get('F')?.active.get('src.out#0')?.breached).toBe(true);
  });

  it('EC-6: a condition satisfied exactly after iteration maxIterations is not a breach; one iteration later is', async () => {
    const run = (frame: 'while' | 'until', condition: string, maxIterations: number) =>
      exec(frameFlow(loopFrame({ frame, condition, maxIterations, fn: 'increment', fnParams: INC })), loopRegistry());

    for (const ok of [await run('until', 'atLeast3', 3), await run('while', 'below3', 3)]) {
      expect(ok.outcome).toEqual({ status: 'succeeded' });
      expect(count(ok.events, 'BudgetExceeded')).toBe(0);
      expect(frameExits(ok.events)[0]).toMatchObject({ reason: 'condition', outputs: [{ value: 3 }] });
    }
    for (const bad of [await run('until', 'atLeast3', 2), await run('while', 'below3', 2)]) {
      expect(bad.outcome).toMatchObject({ status: 'failed', reason: 'budget', node: 'F' });
      expect(bad.events.filter((e) => e.type === 'BudgetExceeded')).toMatchObject([{ budget: 'iterations', limit: 2, used: 2 }]);
      expect(count(bad.events, 'IterationEnded')).toBe(2);
      expect(frameExits(bad.events)).toEqual([]);
    }
  });

  it('frames: a loop body emitting zero or several items fails the run as step, naming the frame', async () => {
    const registry = loopRegistry();
    registry.map('drop', async () => []);
    registry.map('twice', async (item) => [item, item]);
    for (const fn of ['drop', 'twice']) {
      const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'while', condition: 'always', maxIterations: 5, fn })), registry);
      expect(outcome).toMatchObject({ status: 'failed', reason: 'step', node: 'F', message: expect.stringMatching(/\bF\b/) });
      expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'F' });
      expect(frameExits(events)).toEqual([]);
    }
  });

  it('frames: a predicate that throws fails the run as step on the frame node, without a StepFailed event', async () => {
    const registry = loopRegistry();
    registry.predicate('explode', async () => {
      throw new Error('predicate boom');
    });
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'while', condition: 'explode', maxIterations: 5 })), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'F', message: 'predicate boom' });
    expect(events.at(-1)).toMatchObject({ type: 'RunFailed', reason: 'step', node: 'F' });
    expect(count(events, 'StepFailed')).toBe(0);
  });

  it('frames: an unregistered predicate is rejected by the runnability guard before any work, naming the node', async () => {
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'until', condition: 'nope', maxIterations: 5 })), loopRegistry());

    expect(outcome).toMatchObject({ status: 'failed', reason: 'internal', message: expect.stringMatching(/"F".*nope/) });
    expect(events.map((e) => e.type)).toEqual(['RunCreated', 'RunStarted', 'RunFailed']);
  });

  it('frames: conditionParams and the predicate context reach the predicate on every evaluation', async () => {
    const calls: { state: JsonValue; ctx: unknown; params: JsonValue | undefined }[] = [];
    const registry = loopRegistry();
    registry.predicate('spy', async (state, ctx, params) => {
      calls.push({ state, ctx, params });
      return typeof state === 'number' && state < 2;
    });
    const params = { limit: 2, tag: 'x' };
    const def = frameFlow(loopFrame({ frame: 'while', condition: 'spy', conditionParams: params, maxIterations: 10, fn: 'increment', fnParams: INC }));
    const { outcome } = await exec(def, registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(calls.map((c) => c.state)).toEqual([0, 1, 2]); // before each iteration and once more to exit
    for (const c of calls) {
      expect(c.params).toEqual(params);
      expect(Object.keys(c.ctx as object).sort()).toEqual(['itemId', 'node', 'runId', 'signal']);
      expect(c.ctx).toMatchObject({ runId: 'r', node: 'F', itemId: 'src.out#0' });
      expect((c.ctx as { signal: unknown }).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('EC-7: the frame time budget spans iterations; elapsedMs is per iteration; the in-flight step signal is aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const signals: AbortSignal[] = [];
    const registry = loopRegistry();
    registry.map('nap', (item, ctx) =>
      new Promise((resolve, reject) => {
        signals.push(ctx.signal);
        const timer = setTimeout(() => resolve(item), 400);
        ctx.signal.addEventListener('abort', () => (clearTimeout(timer), reject(ctx.signal.reason)), { once: true });
      }),
    );
    const store = new MemoryStore();
    const { expectedSeq } = await startRun(store, 'r', frameFlow(loopFrame({ frame: 'while', condition: 'always', maxIterations: 100, maxDurationMs: 1000, fn: 'nap' })));
    const ac = new AbortController();
    let outcome: RunOutcome | undefined;
    void executeRun({ runId: 'r', store, registry, signal: ac.signal, workerId: 'w1', expectedSeq }).then((o) => (outcome = o));
    try {
      await until(() => signals.length === 1);
      await vi.advanceTimersByTimeAsync(400);
      await until(() => signals.length === 2);
      await vi.advanceTimersByTimeAsync(400);
      await until(() => signals.length === 3);
      await vi.advanceTimersByTimeAsync(199);
      await tick();
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await until(() => outcome !== undefined);
    } finally {
      ac.abort();
    }

    expect(outcome).toMatchObject({ status: 'failed', reason: 'budget', node: 'F' });
    const events = await eventsOf(store, 'r');
    const at = events.findIndex((e) => e.type === 'BudgetExceeded');
    expect(events[at]).toMatchObject({ node: 'F', itemId: 'src.out#0', budget: 'time', limit: 1000 });
    expect((events[at] as Extract<LoopworkEvent, { type: 'BudgetExceeded' }>).used).toBeGreaterThanOrEqual(1000);
    expect(events.slice(at + 1)).toMatchObject([{ type: 'RunFailed', reason: 'budget', node: 'F' }]);
    const ended = events.filter((e) => e.type === 'IterationEnded');
    expect(ended).toHaveLength(2);
    for (const e of ended) {
      expect(e.type === 'IterationEnded' && e.elapsedMs).toBeGreaterThanOrEqual(400);
      expect(e.type === 'IterationEnded' && e.elapsedMs).toBeLessThan(1000);
    }
    expect(frameExits(events)).toEqual([]);
    expect(signals[2]?.aborted).toBe(true);
  });

  it('frames: a long-running loop (2000 iterations on one instance) succeeds quickly and leaves no active instance', { timeout: 2000 }, async () => {
    const def = frameFlow(loopFrame({ frame: 'while', condition: 'below2000', maxIterations: 5000, fn: 'increment', fnParams: INC }));
    const { outcome, events } = await exec(def, loopRegistry());

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(count(events, 'IterationStarted')).toBe(2000);
    expect(frameExits(events)[0]).toMatchObject({ reason: 'condition', outputs: [{ value: 2000 }] });
    expect(foldRun(events).frames.get('F')?.active.size).toBe(0);
  });
});

describe('nested loops', () => {
  it('EC-15: nested frames (foreach > retry > while) execute, retrying a flaky step inside an iteration; the resume half lands in slice 5', async () => {
    const seen = new Map<string, number>();
    const registry = loopRegistry();
    registry.map('flaky', async (item, ctx) => {
      const n = (seen.get(ctx.itemId) ?? 0) + 1;
      seen.set(ctx.itemId, n);
      if (ctx.itemId.endsWith('iter#2') && n === 1) throw new Error('flaky first try');
      return (item as number) + 1;
    });
    const inner = loopFrame({ frame: 'while', condition: 'below3', maxIterations: 10, fn: 'flaky' });
    const retry = retryFrame({ maxAttempts: 3, backoff: { kind: 'fixed', baseMs: 1 }, nodes: { b: inner } });
    const { outcome, events } = await exec(frameFlow(foreachFrame({ concurrency: 2, nodes: { b: retry } }), 4), registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    // states 0 and 1 reach iteration 2 and retry its step once; 2 runs one iteration; 3 is already done
    const failed = events.filter((e) => e.type === 'StepFailed');
    expect(failed.map((e) => e.type === 'StepFailed' && [e.node, e.attempt, e.willRetry])).toEqual([
      ['F.b.b.b', 1, true],
      ['F.b.b.b', 1, true],
    ]);
    const loops = frameExits(events, 'F.b.b');
    expect(loops).toHaveLength(4);
    for (const e of loops) expect(e).toMatchObject({ reason: 'condition', outputs: [{ port: 'out', value: 3 }] });
    expect(frameExits(events, 'F.b').map((e) => e.type === 'FrameExited' && e.reason)).toEqual(['success', 'success', 'success', 'success']);
    expect(frameExits(events, 'F').map((e) => e.type === 'FrameExited' && e.reason)).toEqual(['input-done', 'input-done', 'input-done', 'input-done']);
    expect(foldRun(events).edges.get('F.out->snk.in')).toEqual({ emitted: 4, consumed: 4 });
    expect([...foldRun(events).frames.keys()].sort()).toEqual(['F', 'F.b', 'F.b.b']);
    expectNoActive(events);
  });

  it('EC-15: a while whose body holds a foreach runs that foreach at its configured concurrency inside every iteration', async () => {
    const gauge = { cur: 0, peak: 0 };
    let joined = 0;
    const registry = loopRegistry();
    registry.map('fan3', async (item) => [item, item, item]);
    registry.map('probe', async (item) => {
      gauge.peak = Math.max(gauge.peak, ++gauge.cur);
      for (let i = 0; i < 3; i++) await tick();
      gauge.cur--;
      return item;
    });
    // collapses each iteration's three items back into the single next state
    registry.map('join3', async (item) => (++joined % 3 === 0 ? (item as number) + 1 : []));
    const body = loopFrame({
      frame: 'while',
      condition: 'below2',
      maxIterations: 10,
      nodes: {
        fan: { kind: 'map', fn: 'fan3', in: ANY, out: ANY },
        L: foreachFrame({ concurrency: 3, fn: 'probe' }),
        join: { kind: 'map', fn: 'join3', in: ANY, out: ANY },
      },
      edges: [
        { from: { node: 'fan', port: 'out' }, to: { node: 'L', port: 'in' } },
        { from: { node: 'L', port: 'out' }, to: { node: 'join', port: 'in' } },
      ],
      entry: 'fan',
      exit: 'join',
    });
    const { outcome, events } = await exec(frameFlow(body), registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(gauge.peak).toBe(3);
    expect(events.filter((e) => e.type === 'IterationStarted' && e.node === 'F')).toHaveLength(2);
    expect(frameExits(events, 'F.L')).toHaveLength(6);
    expect(frameExits(events)[0]).toMatchObject({ reason: 'condition', outputs: [{ value: 2 }] });
    expectNoActive(events);
  });

  it('EC-15: an emit-error retry exhausted inside a while abandons that loop instance without failing the run or leaking it', async () => {
    const registry = loopRegistry();
    registry.map('failAtOne', async (item) => {
      if (item === 1) throw new Error('hit one');
      return (item as number) + 1;
    });
    const inner = loopFrame({ frame: 'while', condition: 'below3', maxIterations: 10, fn: 'failAtOne' });
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 3 }, out: ANY })
      .frame('F', retryFrame({ maxAttempts: 1, backoff: { kind: 'fixed', baseMs: 1 }, onExhausted: 'emit-error', nodes: { b: inner } }))
      .sink('snk', { fn: 'discard', in: ANY })
      .sink('errSnk', { fn: 'discard', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .edge('F.error', 'errSnk.in')
      .build();
    const { outcome, events } = await exec(def, registry);

    // state 0 fails in iteration 2, state 1 in iteration 1, state 2 completes
    expect(outcome).toEqual({ status: 'succeeded' });
    expect(trace(events, 'src.out#0', 'F.b')).toEqual([
      'FrameEntered:while',
      'IterationStarted:1',
      'IterationEnded:1',
      'IterationStarted:2',
      'IterationEnded:2',
      'FrameExited:retries-exhausted',
    ]);
    expect(trace(events, 'src.out#1', 'F.b')).toEqual(['FrameEntered:while', 'IterationStarted:1', 'IterationEnded:1', 'FrameExited:retries-exhausted']);
    expect(trace(events, 'src.out#2', 'F.b').at(-1)).toBe('FrameExited:condition');
    const abandoned = frameExits(events, 'F.b').filter((e) => e.type === 'FrameExited' && e.reason === 'retries-exhausted');
    expect(abandoned).toHaveLength(2);
    for (const e of abandoned) expect(e).not.toHaveProperty('outputs');
    expect(frameExits(events, 'F').map((e) => e.type === 'FrameExited' && e.reason)).toEqual(['retries-exhausted', 'retries-exhausted', 'success']);
    const state = foldRun(events);
    expect(state.edges.get('F.error->errSnk.in')).toEqual({ emitted: 2, consumed: 2 });
    expect(state.edges.get('F.out->snk.in')).toEqual({ emitted: 1, consumed: 1 });
    expectNoActive(events);
  });
});

describe('loop repair round', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('EC-15: once an enclosing emit-error retry is exhausted, a queued sibling loop instance starts no iteration and exits retries-exhausted', async () => {
    const registry = loopRegistry();
    registry.map('fan2', async (item) => [item, item]);
    registry.map('boom', async () => {
      throw new Error('boom');
    });
    const inner = loopFrame({ frame: 'while', condition: 'always', maxIterations: 5, fn: 'boom' });
    const retry = retryFrame({
      maxAttempts: 1,
      backoff: { kind: 'fixed', baseMs: 1 },
      onExhausted: 'emit-error',
      nodes: { b: { kind: 'map', fn: 'fan2', in: ANY, out: ANY }, W: inner },
      edges: [{ from: { node: 'b', port: 'out' }, to: { node: 'W', port: 'in' } }],
      exit: 'W',
    });
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 1 }, out: ANY })
      .frame('F', retry)
      .sink('snk', { fn: 'discard', in: ANY })
      .sink('errSnk', { fn: 'discard', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .edge('F.error', 'errSnk.in')
      .build();
    const { outcome, events } = await exec(def, registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(events.filter((e) => e.type === 'StepStarted' && e.node === 'F.W.b')).toHaveLength(1); // the sibling's body never started
    expect(trace(events, 'src.out#0>F.b.out#0', 'F.W')).toEqual(['FrameEntered:while', 'IterationStarted:1', 'IterationEnded:1', 'FrameExited:retries-exhausted']);
    expect(trace(events, 'src.out#0>F.b.out#1', 'F.W')).toEqual(['FrameEntered:while', 'FrameExited:retries-exhausted']);
    for (const e of frameExits(events, 'F.W')) expect(e).not.toHaveProperty('outputs');
    expectNoActive(events);
  });

  it('EC-7: IterationEnded.elapsedMs covers the predicate time between iterations; the whole-instance timer still enforces maxDurationMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const registry = loopRegistry();
    const slow = (ok: (s: JsonValue) => boolean) => async (s: JsonValue) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      return ok(s);
    };
    registry.predicate('slowBelow3', slow((s) => typeof s === 'number' && s < 3));
    registry.predicate('slowAlways', slow(() => true));
    const run = async (def: Flow) => {
      const r = await start(def, registry);
      try {
        for (let i = 0; i < 200 && r.outcome() === undefined; i++) {
          await tick();
          await vi.advanceTimersByTimeAsync(50);
        }
      } finally {
        r.stop();
      }
      return { outcome: r.outcome(), events: await r.events() };
    };

    const ok = await run(frameFlow(loopFrame({ frame: 'while', condition: 'slowBelow3', maxIterations: 10, fn: 'increment', fnParams: INC })));
    expect(ok.outcome).toEqual({ status: 'succeeded' });
    const ended = ok.events.flatMap((e) => (e.type === 'IterationEnded' ? [e.elapsedMs] : []));
    expect(ended).toHaveLength(3);
    for (const ms of ended) expect(ms).toBeGreaterThanOrEqual(300); // each carries the check before it
    expect(ended.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(900); // 4 checks x 300 ms, minus the final one that is not logged

    const over = await run(frameFlow(loopFrame({ frame: 'while', condition: 'slowAlways', maxIterations: 100, maxDurationMs: 1000, fn: 'increment', fnParams: INC })));
    expect(over.outcome).toMatchObject({ status: 'failed', reason: 'budget', node: 'F' });
    expect(over.events.filter((e) => e.type === 'BudgetExceeded')).toMatchObject([{ budget: 'time', limit: 1000 }]);
  });

  /** Runs until the third instance's exit is blocked on the gated sink, lets the (tiny) budget lapse, then opens the gate. */
  async function blockedSendOutlivesBudget(def: Flow, registry: NodeRegistry, open: () => void): Promise<LoopworkEvent[]> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = await start(def, registry);
    try {
      for (let i = 0; i < 30; i++) await tick();
      expect(count(await r.events(), 'FrameExited')).toBeGreaterThanOrEqual(2); // the exits are logged, the last delivery is blocked
      await vi.advanceTimersByTimeAsync(500); // far past the 100 ms budget
      await tick();
      expect(r.outcome()).toBeUndefined();
      open();
      await until(() => r.outcome() !== undefined);
    } finally {
      r.stop();
    }
    expect(r.outcome()).toEqual({ status: 'succeeded' });
    return r.events();
  }

  it('frames: a loop exit blocked on downstream backpressure past maxDurationMs does not log BudgetExceeded after FrameExited', async () => {
    const { registry, open } = gatedRegistry();
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 3 }, out: ANY })
      .frame('F', withBudget(loopFrame({ frame: 'while', condition: 'never', maxIterations: 5 }), 100))
      .sink('snk', { fn: 'gate', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .build();
    const events = await blockedSendOutlivesBudget(def, registry, open);

    expect(count(events, 'BudgetExceeded')).toBe(0);
    expect(count(events, 'RunFailed')).toBe(0);
    expect(frameExits(events)).toHaveLength(3);
  });

  it('frames: a retry emit-error send blocked on downstream backpressure past maxDurationMs does not log BudgetExceeded after FrameExited', async () => {
    const { registry, open } = gatedRegistry();
    registry.map('boom', async () => {
      throw new Error('boom');
    });
    const retry = retryFrame({ maxAttempts: 1, backoff: { kind: 'fixed', baseMs: 1 }, onExhausted: 'emit-error', nodes: { b: { kind: 'map', fn: 'boom', in: ANY, out: ANY } } });
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 3 }, out: ANY })
      .frame('F', withBudget(retry, 100))
      .sink('snk', { fn: 'discard', in: ANY })
      .sink('errSnk', { fn: 'gate', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .edge('F.error', 'errSnk.in')
      .build();
    const events = await blockedSendOutlivesBudget(def, registry, open);

    expect(count(events, 'BudgetExceeded')).toBe(0);
    expect(count(events, 'RunFailed')).toBe(0);
    expect(frameExits(events).map((e) => e.type === 'FrameExited' && e.reason)).toEqual(['retries-exhausted', 'retries-exhausted', 'retries-exhausted']);
  });

  it('frames: an until predicate that throws after the body fails the run as step on the frame node, without a StepFailed event', async () => {
    const registry = loopRegistry();
    registry.predicate('explode', async () => {
      throw new Error('until boom');
    });
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'until', condition: 'explode', maxIterations: 5, fn: 'increment', fnParams: INC })), registry);

    expect(outcome).toEqual({ status: 'failed', reason: 'step', node: 'F', message: 'until boom' });
    expect(count(events, 'StepFailed')).toBe(0);
    expect(events.slice(-2)).toMatchObject([{ type: 'IterationEnded', node: 'F', iteration: 1 }, { type: 'RunFailed', reason: 'step', node: 'F' }]);
    expect(frameExits(events)).toEqual([]);
  });

  it('EC-15: a while whose body is a fail-run retry retries a flaky step inside the iteration and the loop completes', async () => {
    const seen = new Map<string, number>();
    const registry = loopRegistry();
    registry.map('flaky', async (item, ctx) => {
      const n = (seen.get(ctx.itemId) ?? 0) + 1;
      seen.set(ctx.itemId, n);
      if (ctx.itemId.endsWith('iter#2') && n === 1) throw new Error('flaky first try');
      return (item as number) + 1;
    });
    const retry = retryFrame({ maxAttempts: 3, backoff: { kind: 'fixed', baseMs: 1 }, nodes: { b: { kind: 'map', fn: 'flaky', in: ANY, out: ANY } } });
    const { outcome, events } = await exec(frameFlow(loopFrame({ frame: 'while', condition: 'below3', maxIterations: 10, nodes: { b: retry } })), registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(events.filter((e) => e.type === 'StepFailed').map((e) => e.type === 'StepFailed' && [e.node, e.attempt, e.willRetry])).toEqual([['F.b.b', 1, true]]);
    expect(trace(events, 'src.out#0').filter((t) => t.startsWith('IterationStarted'))).toHaveLength(3);
    expect(frameExits(events)[0]).toMatchObject({ reason: 'condition', outputs: [{ value: 3 }] });
    expect(frameExits(events, 'F.b').map((e) => e.type === 'FrameExited' && e.reason)).toEqual(['success', 'success', 'success']);
    expectNoActive(events);
  });
});
