import type { Flow, FlowNode } from '@loopwork/graph';
import type { NewEvent } from '../src/events.js';

// mulberry32: tiny seeded PRNG, so no dependency and the same seed always gives the same stream.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const map = (): FlowNode => ({ kind: 'map', fn: 'identity', in: {}, out: {} });
const foreach = (nodes: Record<string, FlowNode>, entry: string, exit: string, edges: { a: string; b: string }[] = []): FlowNode => ({
  kind: 'frame',
  frame: 'foreach',
  budgets: { maxIterations: 10, maxDurationMs: 1000 },
  concurrency: 2,
  in: {},
  out: {},
  body: {
    nodes,
    edges: edges.map(({ a, b }) => ({ from: { node: a, port: 'out' }, to: { node: b, port: 'in' } })),
    entry: { node: entry, port: 'in' },
    exit: { node: exit, port: 'out' },
  },
});
const flowOf = (name: string, loop: FlowNode): Flow => ({
  version: 1,
  id: `flow-${name}`,
  name,
  nodes: { src: { kind: 'source', fn: 'range', out: {} }, m: map(), loop, snk: { kind: 'sink', fn: 'discard', in: {} } },
  edges: [
    { from: { node: 'src', port: 'out' }, to: { node: 'm', port: 'in' } },
    { from: { node: 'm', port: 'out' }, to: { node: 'loop', port: 'in' } },
    { from: { node: 'loop', port: 'out' }, to: { node: 'snk', port: 'in' } },
  ],
});

// src -> m -> loop(foreach: b1 -> b2) -> snk, and a variant whose loop body nests a second foreach frame.
const FLAT = { flow: flowOf('flat', foreach({ b1: map(), b2: map() }, 'b1', 'b2', [{ a: 'b1', b: 'b2' }])), frames: ['loop'], steps: ['m', 'loop.b1', 'loop.b2'] };
const NESTED = {
  flow: flowOf('nested', foreach({ b1: map(), inner: foreach({ ib: map() }, 'ib', 'ib') }, 'b1', 'inner', [{ a: 'b1', b: 'inner' }])),
  frames: ['loop', 'loop.inner'],
  steps: ['m', 'loop.b1', 'loop.inner.ib'],
};

/**
 * A random log the store must accept: starts with RunCreated, then attempts (RunStarted with a strictly higher attempt),
 * each with a body of step/frame/source events, each ending failed (and then maybe resumed), succeeded, cancelled, or
 * open. Nothing follows succeeded or cancelled. Deterministic per seed; at most `maxEvents` events (min 1).
 */
export function genValidLog(seed: number, opts: { maxEvents?: number } = {}): NewEvent[] {
  const max = Math.max(opts.maxEvents ?? 60, 1);
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  const { flow, frames, steps } = rnd() < 0.3 ? NESTED : FLAT;
  const log: NewEvent[] = [{ type: 'RunCreated', flow, createdBy: pick(['cli', 'mcp', 'ui', 'api'] as const) }];
  let nextItem = 0;

  const step = (node: string, itemId: string): NewEvent[] => {
    const outId = `${itemId}>${node}.out#0`;
    const ok: NewEvent = { type: 'StepSucceeded', node, itemId, outputs: [{ port: 'out', itemId: outId, value: int(100) }] };
    const err = (attempt: number, willRetry: boolean): NewEvent => ({
      type: 'StepFailed',
      node,
      itemId,
      attempt,
      error: { name: 'Error', message: `e${int(10)}` },
      willRetry,
    });
    const start = (attempt: number): NewEvent => ({ type: 'StepStarted', node, itemId, attempt });
    switch (int(3)) {
      case 0:
        return [start(1), ok];
      case 1:
        return [start(1), err(1, true), start(2), rnd() < 0.5 ? ok : err(2, false)];
      default:
        return [start(1), err(1, false)];
    }
  };
  const frame = (node: string, itemId: string): NewEvent[] => {
    const out: NewEvent[] = [{ type: 'FrameEntered', node, itemId, frame: 'foreach' }];
    const n = 1 + int(3);
    for (let iteration = 0; iteration < n; iteration++) {
      out.push({ type: 'IterationStarted', node, itemId, iteration });
      out.push(...step(pick(steps), `${itemId}#${iteration}`));
      out.push({ type: 'IterationEnded', node, itemId, iteration, elapsedMs: int(500) });
    }
    out.push({ type: 'FrameExited', node, itemId, reason: pick(['input-done', 'condition', 'success', 'retries-exhausted'] as const) });
    return out;
  };
  const chunk = (): NewEvent[] => {
    const itemId = `src.out#${nextItem++}`;
    switch (int(6)) {
      case 0:
        return [{ type: 'ItemEmitted', node: 'src', itemId, value: int(100) }, ...step('m', itemId)];
      case 1:
        return frame(pick(frames), itemId);
      case 2:
        return [{ type: 'SideEffect', node: pick(steps), itemId, key: pick(['now', 'random', 'k']), value: int(1000) }];
      case 3:
        return [{ type: 'SourceCompleted', node: 'src', count: nextItem }];
      case 4:
        return [{ type: 'BudgetExceeded', node: pick(frames), itemId, budget: pick(['iterations', 'time'] as const), limit: 10, used: 11 + int(5) }];
      default:
        return step(pick(steps), itemId);
    }
  };

  // Pushes while the log has room for `reserve` more events after it; a chunk may be cut short (a crash mid-chunk).
  const room = (reserve: number) => max - log.length - reserve;
  const body = (reserve: number) => {
    const budget = int(Math.max(room(reserve), 0) + 1);
    const stop = log.length + budget;
    while (log.length < stop) log.push(...chunk().slice(0, stop - log.length));
  };

  let attempt = 0;
  while (room(0) > 0) {
    if (rnd() < 0.1 && attempt === 0) {
      body(1);
      if (room(0) > 0 && rnd() < 0.5) log.push({ type: 'RunCancelled' }); // never started
      break;
    }
    attempt += 1 + int(2);
    log.push({ type: 'RunStarted', workerId: `w${int(3)}`, attempt });
    body(1);
    if (room(0) <= 0) break;
    const end = rnd();
    if (end < 0.25) break; // left open (running)
    if (end < 0.45) log.push({ type: 'RunSucceeded' });
    else if (end < 0.55) log.push({ type: 'RunCancelled', requestedBy: 'user' });
    else {
      log.push({
        type: 'RunFailed',
        reason: pick(['step', 'budget', 'crash-loop', 'internal'] as const),
        message: 'boom',
        ...(rnd() < 0.5 ? { node: pick(steps) } : {}),
      });
      if (rnd() < 0.5) continue; // resume with a higher attempt, if there is still room
    }
    break;
  }
  return log;
}
