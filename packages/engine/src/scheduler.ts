import type { Channel } from './channel.js';

export interface Limiter {
  acquire(): Promise<void>;
  release(): void;
  readonly inFlight: number;
}

/** Global in-flight cap: `acquire` waits (FIFO) while `max` permits are held; `release` hands its permit straight to the oldest waiter. */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`limiter max must be an integer >= 1, got ${max}`);
  }
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  return {
    get inFlight() {
      return inFlight;
    },
    acquire() {
      if (inFlight < max) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else inFlight--;
    },
  };
}

/**
 * Runs `concurrency` worker loops over `input`. Resolves once the input is closed and drained (or `signal`
 * aborts) and all running handlers returned. `handle` runs holding a limiter permit; it may return a
 * continuation, which runs after the permit is released (so backpressured sends never hold the shared cap)
 * and before the worker takes its next item. On the first handler/continuation error no further items are
 * started, siblings are allowed to settle, and the pool rejects with that first error.
 */
export async function runPool<T>(o: {
  input: Channel<T>;
  concurrency: number;
  limiter: Limiter;
  handle: (item: T) => Promise<void | (() => Promise<void>)>;
  signal: AbortSignal;
}): Promise<void> {
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) {
    throw new RangeError(`pool concurrency must be an integer >= 1, got ${o.concurrency}`);
  }
  const { input, limiter, handle } = o;
  // Aborted by the caller's signal or by the first handler error; wakes workers blocked on `recv`.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (o.signal.aborted) return;
  o.signal.addEventListener('abort', onAbort, { once: true });

  const worker = async (): Promise<void> => {
    while (!stop.signal.aborted) {
      let r;
      try {
        r = await input.recv(stop.signal);
      } catch (e) {
        if (stop.signal.aborted) return;
        throw e;
      }
      if (r.done) return;
      // `acquire` is not abortable: handlers honour the signal, and a parked worker is woken when a holder releases.
      await limiter.acquire();
      let next: void | (() => Promise<void>);
      try {
        if (stop.signal.aborted) return;
        next = await handle(r.value);
      } finally {
        limiter.release();
      }
      if (next) await next();
    }
  };

  let failed = false;
  let firstError: unknown;
  try {
    await Promise.allSettled(
      Array.from({ length: o.concurrency }, () =>
        worker().catch((e: unknown) => {
          if (!failed) {
            failed = true;
            firstError = e;
          }
          stop.abort();
        }),
      ),
    );
  } finally {
    o.signal.removeEventListener('abort', onAbort);
  }
  if (failed) throw firstError;
}
