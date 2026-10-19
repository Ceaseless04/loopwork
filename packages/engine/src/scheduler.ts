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
 * aborts) and all running handlers returned; rejects with the first handler error, after which no further
 * items are started.
 */
export async function runPool<T>(o: {
  input: Channel<T>;
  concurrency: number;
  limiter: Limiter;
  handle: (item: T) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
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
      await limiter.acquire();
      try {
        if (stop.signal.aborted) return;
        await handle(r.value);
      } finally {
        limiter.release();
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: o.concurrency }, () =>
        worker().catch((e: unknown) => {
          stop.abort();
          throw e;
        }),
      ),
    );
  } finally {
    o.signal.removeEventListener('abort', onAbort);
  }
}
