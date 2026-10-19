import { describe, expect, it } from 'vitest';
import { createChannel, type Channel } from '../src/channel.js';
import { createLimiter, runPool } from '../src/scheduler.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function feed<T>(items: T[], close = true): Promise<Channel<T>> {
  const ch = createChannel<T>(Math.max(items.length, 1));
  for (const i of items) await ch.send(i);
  if (close) ch.close();
  return ch;
}

/** A handler that parks every call on its own deferred, tracking current/peak concurrency (shared via `gauge`). */
function gate<T>(gauge = { current: 0, peak: 0 }) {
  const pending: { item: T; d: Deferred }[] = [];
  const started: T[] = [];
  const handle = async (item: T) => {
    const d = deferred();
    pending.push({ item, d });
    started.push(item);
    gauge.current++;
    gauge.peak = Math.max(gauge.peak, gauge.current);
    try {
      await d.promise;
    } finally {
      gauge.current--;
    }
  };
  /** Repeatedly releases all parked calls until none remain after a tick. */
  const drain = async () => {
    for (;;) {
      await tick();
      const batch = pending.splice(0);
      if (batch.length === 0) return;
      for (const b of batch) b.d.resolve();
    }
  };
  return { handle, pending, started, gauge, drain };
}

describe('limiter', () => {
  it('scheduler: acquire is capped at max, release admits waiters in FIFO order', async () => {
    const lim = createLimiter(2);
    await lim.acquire();
    await lim.acquire();
    expect(lim.inFlight).toBe(2);

    const order: number[] = [];
    const a = lim.acquire().then(() => order.push(1));
    const b = lim.acquire().then(() => order.push(2));
    await tick();
    expect(order).toEqual([]);
    expect(lim.inFlight).toBe(2);

    lim.release();
    await a;
    expect(order).toEqual([1]);
    lim.release();
    await b;
    expect(order).toEqual([1, 2]);
    expect(lim.inFlight).toBe(2);
  });
});

describe('runPool', () => {
  it('EC-3: a node with concurrency k never has more than k handlers in flight and reaches k when work is available', async () => {
    const k = 3;
    const input = await feed(Array.from({ length: 3 * k }, (_, i) => i));
    const g = gate<number>();
    const pool = runPool({
      input,
      concurrency: k,
      limiter: createLimiter(100),
      handle: g.handle,
      signal: new AbortController().signal,
    });
    await tick();
    expect(g.gauge.current).toBe(k);
    await g.drain();
    await pool;
    expect(g.started).toHaveLength(3 * k);
    expect(g.gauge.peak).toBe(k);
  });

  it('EC-3: maxInFlight caps the total across pools', async () => {
    const gauge = { current: 0, peak: 0 };
    const limiter = createLimiter(4);
    const a = gate<number>(gauge);
    const b = gate<number>(gauge);
    const signal = new AbortController().signal;
    const poolA = runPool({ input: await feed([1, 2, 3, 4, 5, 6]), concurrency: 3, limiter, handle: a.handle, signal });
    const poolB = runPool({ input: await feed([1, 2, 3, 4, 5, 6]), concurrency: 3, limiter, handle: b.handle, signal });
    await tick();
    expect(gauge.current).toBe(4);
    expect(limiter.inFlight).toBe(4);
    while (a.started.length + b.started.length < 12 || gauge.current > 0) {
      for (const p of [...a.pending.splice(0), ...b.pending.splice(0)]) p.d.resolve();
      await tick();
    }
    await Promise.all([poolA, poolB]);
    expect(gauge.peak).toBe(4);
    expect(limiter.inFlight).toBe(0);
  });

  it('scheduler: concurrency 1 processes items in input order', async () => {
    const seen: number[] = [];
    await runPool({
      input: await feed([1, 2, 3, 4]),
      concurrency: 1,
      limiter: createLimiter(10),
      handle: async (n) => {
        await tick();
        seen.push(n);
      },
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('scheduler: with concurrency > 1 outputs follow completion order, not input order', async () => {
    const input = await feed(['slow', 'fast']);
    const output = createChannel<string>(2);
    const g = gate<string>();
    const pool = runPool({
      input,
      concurrency: 2,
      limiter: createLimiter(10),
      handle: async (item) => {
        await g.handle(item);
        await output.send(item);
      },
      signal: new AbortController().signal,
    });
    await tick();
    g.pending.find((p) => p.item === 'fast')?.d.resolve();
    await tick();
    g.pending.find((p) => p.item === 'slow')?.d.resolve();
    await pool;
    output.close();
    const out: string[] = [];
    for (let r = await output.recv(); !r.done; r = await output.recv()) out.push(r.value);
    expect(out).toEqual(['fast', 'slow']);
  });

  it('scheduler: a handler error rejects the pool with that error and no further items are taken', async () => {
    const boom = new Error('boom');
    const handled: number[] = [];
    const limiter = createLimiter(10);
    const pool = runPool({
      input: await feed([1, 2, 3, 4, 5]),
      concurrency: 1,
      limiter,
      handle: async (n) => {
        handled.push(n);
        if (n === 2) throw boom;
      },
      signal: new AbortController().signal,
    });
    await expect(pool).rejects.toBe(boom);
    expect(handled).toEqual([1, 2]);
    expect(limiter.inFlight).toBe(0);
  });

  it('scheduler: abort stops taking new items', async () => {
    const ac = new AbortController();
    const input = await feed([1, 2, 3, 4], false);
    const g = gate<number>();
    const pool = runPool({ input, concurrency: 1, limiter: createLimiter(10), handle: g.handle, signal: ac.signal });
    const settled = pool.then(
      () => undefined,
      () => undefined,
    );
    await tick();
    expect(g.started).toEqual([1]);

    ac.abort();
    await g.drain();
    await settled;
    expect(g.started).toEqual([1]);
  });

  it('scheduler: a worker woken from the limiter after abort skips its item and releases the permit it was handed', async () => {
    const ac = new AbortController();
    const lim = createLimiter(1);
    await lim.acquire();
    const seen: number[] = [];
    const pool = runPool({
      input: await feed([1], false),
      concurrency: 1,
      limiter: lim,
      handle: async (n) => {
        seen.push(n);
      },
      signal: ac.signal,
    });
    const settled = pool.then(
      () => undefined,
      () => undefined,
    );
    await tick();

    ac.abort();
    lim.release();
    await settled;
    expect(seen).toEqual([]);
    expect(lim.inFlight).toBe(0);
  });
});
