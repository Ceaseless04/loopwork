import { MemoryStore, foldRun, type LoopworkEvent } from '@loopwork/eventlog';
import { flow, type Flow, type JsonValue } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun } from '../src/index.js';
import { eventsOf, foreachFrame, frameFlow, retryFrame, startRun } from './helpers.js';

const ANY = {};

async function exec(def: Flow, registry = createBuiltins(), opts: { maxInFlight?: number; guardMs?: number } = {}) {
  const store = new MemoryStore();
  const { expectedSeq } = await startRun(store, 'r', def);
  const run = executeRun({ runId: 'r', store, registry, signal: new AbortController().signal, workerId: 'w1', expectedSeq, ...(opts.maxInFlight !== undefined && { maxInFlight: opts.maxInFlight }) });
  // A deadlocked run never settles: with a guard it fails fast as `hung` instead of waiting for the test timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ status: 'hung' }>((resolve) => {
    if (opts.guardMs !== undefined) timer = setTimeout(() => resolve({ status: 'hung' }), opts.guardMs);
  });
  const outcome = await Promise.race([run, hung]);
  clearTimeout(timer);
  return { outcome, events: await eventsOf(store, 'r') };
}

/** A map `probe` that records its peak parallelism after yielding a few macrotasks (no wall-clock waits). */
function probeRegistry() {
  const registry = createBuiltins();
  const gauge = { cur: 0, peak: 0 };
  registry.map('probe', async (item: JsonValue) => {
    gauge.peak = Math.max(gauge.peak, ++gauge.cur);
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    gauge.cur--;
    return item;
  });
  return { registry, gauge };
}

/** Peak number of frame instances between FrameEntered and FrameExited, by log order. */
function peakInstances(events: LoopworkEvent[]): number {
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    if (e.type === 'FrameEntered') peak = Math.max(peak, ++cur);
    else if (e.type === 'FrameExited') cur--;
  }
  return peak;
}

describe('foreach frames', () => {
  it('EC-4: foreach runs one iteration per input item with the configured body concurrency and one FrameEntered/FrameExited per item', async () => {
    const N = 6;
    const { registry, gauge } = probeRegistry();
    const body = { b: { kind: 'map' as const, fn: 'probe', in: ANY, out: ANY, concurrency: 2 } };
    const { outcome, events } = await exec(frameFlow(foreachFrame({ concurrency: 3, nodes: body }), N), registry);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const ids = Array.from({ length: N }, (_, i) => `src.out#${i}`);
    expect(events.filter((e) => e.type === 'FrameEntered').map((e) => e.itemId).sort()).toEqual(ids);
    expect(events.filter((e) => e.type === 'FrameEntered' && e.frame !== 'foreach')).toEqual([]);
    const exits = events.filter((e) => e.type === 'FrameExited');
    expect(exits.map((e) => e.itemId).sort()).toEqual(ids);
    for (const e of exits) {
      expect(e).toMatchObject({ node: 'F', reason: 'input-done' });
      expect(e).not.toHaveProperty('outputs');
    }

    for (const id of ids) {
      const at = (type: LoopworkEvent['type'], node: string): number =>
        events.findIndex((e) => e.type === type && 'node' in e && e.node === node && 'itemId' in e && e.itemId === id);
      const order = [
        at('FrameEntered', 'F'),
        at('IterationStarted', 'F'),
        at('StepStarted', 'F.b'),
        at('StepSucceeded', 'F.b'),
        at('IterationEnded', 'F'),
        at('FrameExited', 'F'),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(events[order[1] ?? -1]).toMatchObject({ iteration: 1 });
      expect(events[order[4] ?? -1]).toMatchObject({ iteration: 1 });
      expect(events[order[3] ?? -1]).toMatchObject({ outputs: [{ port: 'out', itemId: `${id}>F.b.out#0` }] });
    }

    // every body output reaches the downstream sink
    const sunk = events.flatMap((e) => (e.type === 'StepStarted' && e.node === 'snk' ? [e.itemId] : []));
    expect(sunk.sort()).toEqual(ids.map((id) => `${id}>F.b.out#0`));

    // frame concurrency bounds instances in flight; the body node's own limiter bounds its steps
    expect(peakInstances(events)).toBe(3);
    expect(gauge.peak).toBe(2);

    const state = foldRun(events);
    expect(state.status).toBe('succeeded');
    const frame = state.frames.get('F');
    expect(frame?.exitedCount).toBe(N);
    expect(frame?.active.size).toBe(0);
    for (const c of state.edges.values()) expect(c).toEqual({ emitted: N, consumed: N });
    expect(state.edges.get('F.out->snk.in')).toEqual({ emitted: N, consumed: N });

    // a body node's concurrency is shared across instances, not multiplied by the frame concurrency
    const shared = probeRegistry();
    const one = { b: { kind: 'map' as const, fn: 'probe', in: ANY, out: ANY, concurrency: 1 } };
    const second = await exec(frameFlow(foreachFrame({ concurrency: 3, nodes: one }), N), shared.registry);
    expect(second.outcome).toEqual({ status: 'succeeded' });
    expect(shared.gauge.peak).toBe(1);

    // a body node without its own concurrency inherits the frame's (shared across instances), never exceeding it
    const inherited = probeRegistry();
    const unset = { b: { kind: 'map' as const, fn: 'probe', in: ANY, out: ANY } };
    const third = await exec(frameFlow(foreachFrame({ concurrency: 3, nodes: unset }), N), inherited.registry);
    expect(third.outcome).toEqual({ status: 'succeeded' });
    expect(inherited.gauge.peak).toBe(3);
  });

  it('frames: foreach bodies are validated recursively (a nested while with an unregistered predicate and a body source are rejected as internal)', async () => {
    const nested = foreachFrame({
      concurrency: 1,
      nodes: {
        b: {
          kind: 'frame',
          frame: 'while',
          body: { nodes: {}, edges: [], entry: { node: 'x', port: 'in' }, exit: { node: 'x', port: 'out' } },
          budgets: { maxIterations: 1, maxDurationMs: 1000 },
          condition: 'go',
          in: ANY,
          out: ANY,
        },
      },
    });
    const inner = await exec(frameFlow(nested));
    expect(inner.outcome).toMatchObject({ status: 'failed', reason: 'internal', message: expect.stringMatching(/"F\.b"/) });
    expect(inner.outcome).toMatchObject({ message: expect.stringMatching(/unknown predicate "go"/) });
    expect(inner.events.map((e) => e.type)).toEqual(['RunCreated', 'RunStarted', 'RunFailed']);

    const sourced = foreachFrame({
      concurrency: 1,
      nodes: { b: { kind: 'map', fn: 'identity', in: ANY, out: ANY }, s: { kind: 'source', fn: 'range', out: ANY } },
    });
    const withSource = await exec(frameFlow(sourced));
    expect(withSource.outcome).toMatchObject({ status: 'failed', reason: 'internal', message: expect.stringMatching(/F\.s.*source|source.*F\.s/i) });

    const unknown = await exec(frameFlow(foreachFrame({ concurrency: 1, fn: 'nope' })));
    expect(unknown.outcome).toMatchObject({ status: 'failed', reason: 'internal', message: expect.stringMatching(/"F\.b".*nope/) });
    expect(unknown.events.map((e) => e.type)).toEqual(['RunCreated', 'RunStarted', 'RunFailed']);

    const plain = await exec(frameFlow(foreachFrame({ concurrency: 1 }), 2));
    expect(plain.outcome).toEqual({ status: 'succeeded' });
  });

  it('frames: the foreach pool uses its own limiter, so instances never hold global permits the body steps need', async () => {
    // maxInFlight equals the frame concurrency, and every body step waits until all three run at once: were instances charged
    // to the global limiter, the permits would be gone before the third body step could start.
    let running = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    const registry = createBuiltins();
    registry.map('together', async (item) => {
      if (++running === 3) release();
      await all;
      return item;
    });
    const { outcome } = await exec(frameFlow(foreachFrame({ concurrency: 3, fn: 'together' }), 3), registry, { maxInFlight: 3, guardMs: 1000 });
    expect(outcome).toEqual({ status: 'succeeded' });
  });

  it('frames: a body step waits on its node limiter before taking a global permit (waiters hold no global slot)', async () => {
    const ticks = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    let bStarted!: () => void;
    const started = new Promise<void>((resolve) => (bStarted = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const registry = createBuiltins();
    registry.map('gated', async (item) => {
      bStarted();
      await gate;
      return item;
    });
    // `late` yields once b#0 is running and the other instances have had time to queue, so `side` needs a global permit only then.
    registry.source('late', async function* () {
      await started;
      await ticks(10);
      yield 1;
    });
    registry.sink('open', async () => open());
    const body = { b: { kind: 'map' as const, fn: 'gated', in: ANY, out: ANY, concurrency: 1 } };
    const def = flow('f', 'F')
      .source('src', { fn: 'range', params: { count: 3 }, out: ANY })
      .frame('F', foreachFrame({ concurrency: 3, nodes: body }))
      .sink('snk', { fn: 'discard', in: ANY })
      .source('src2', { fn: 'late', out: ANY })
      .sink('side', { fn: 'open', in: ANY })
      .edge('src.out', 'F.in')
      .edge('F.out', 'snk.in')
      .edge('src2.out', 'side.in')
      .build();

    // b#0 holds the node permit and one of two global permits; b#1, b#2 queue on the node limiter only, leaving `side` a global permit.
    const { outcome } = await exec(def, registry, { maxInFlight: 2, guardMs: 1000 });
    expect(outcome).toEqual({ status: 'succeeded' });
  });

  it('frames: a retry frame inside a foreach body runs its instances in parallel, up to the inherited foreach concurrency', async () => {
    const { registry, gauge } = probeRegistry();
    const probe = { b: { kind: 'map' as const, fn: 'probe', in: ANY, out: ANY } };
    const retry = retryFrame({ maxAttempts: 1, backoff: { kind: 'fixed', baseMs: 1000 }, nodes: probe });
    const { outcome } = await exec(frameFlow(foreachFrame({ concurrency: 4, nodes: { b: retry } }), 8), registry, { guardMs: 3000 });
    expect(outcome).toEqual({ status: 'succeeded' });
    expect(gauge.peak).toBe(4);
  });

  describe('body concurrency inside one foreach instance', () => {
    const run = async (concurrency?: number): Promise<number> => {
      const { registry, gauge } = probeRegistry();
      registry.map('fan', async () => [0, 1, 2, 3]);
      const nodes = {
        a: { kind: 'map' as const, fn: 'fan', in: ANY, out: ANY },
        b: { kind: 'map' as const, fn: 'probe', in: ANY, out: ANY, ...(concurrency !== undefined && { concurrency }) },
      };
      const body = foreachFrame({ concurrency: 4, nodes, edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }], entry: 'a', exit: 'b' });
      const { outcome } = await exec(frameFlow(body, 1), registry, { guardMs: 3000 });
      expect(outcome).toEqual({ status: 'succeeded' });
      return gauge.peak;
    };

    it('frames: a body node without its own concurrency inherits the frame concurrency across its pool workers', async () => {
      expect(await run()).toBe(4);
    });

    it('frames: a body node with its own concurrency keeps it across its pool workers', async () => {
      expect(await run(2)).toBe(2);
    });
  });
});
