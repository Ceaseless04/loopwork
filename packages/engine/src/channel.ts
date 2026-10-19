export type RecvResult<T> = { done: false; value: T } | { done: true };

export interface Channel<T> {
  readonly capacity: number;
  /** Buffered items. */
  readonly size: number;
  /** Resolves once the item is buffered or handed to a waiting receiver; waits while full. */
  send(value: T, signal?: AbortSignal): Promise<void>;
  /** Waits while empty; `{ done: true }` once closed AND drained. */
  recv(signal?: AbortSignal): Promise<RecvResult<T>>;
  /** Idempotent; wakes receivers, rejects pending sends with ChannelClosedError. */
  close(): void;
}

export class ChannelClosedError extends Error {
  override name = 'ChannelClosedError';
  constructor() {
    super('channel is closed');
  }
}

interface Waiter<V> {
  resolve: (v: V) => void;
  reject: (e: unknown) => void;
}
interface PendingSend<T> extends Waiter<void> {
  value: T;
}

/** Parks a waiter in `queue` until it is resolved/rejected or `signal` aborts (which removes it). */
function park<V, W extends Waiter<V>>(
  queue: W[],
  signal: AbortSignal | undefined,
  make: (w: Waiter<V>) => W,
): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const waiter = make({
      resolve: (v) => (cleanup(), resolve(v)),
      reject: (e) => (cleanup(), reject(e)),
    });
    const onAbort = () => {
      queue.splice(queue.indexOf(waiter), 1);
      reject(signal?.reason);
    };
    queue.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createChannel<T>(capacity: number): Channel<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`channel capacity must be an integer >= 1, got ${capacity}`);
  }
  const buffer: T[] = [];
  const receivers: Waiter<RecvResult<T>>[] = [];
  const senders: PendingSend<T>[] = [];
  let closed = false;

  return {
    capacity,
    get size() {
      return buffer.length;
    },
    send(value, signal) {
      if (closed) return Promise.reject(new ChannelClosedError());
      const receiver = receivers.shift();
      if (receiver) {
        receiver.resolve({ done: false, value });
        return Promise.resolve();
      }
      if (buffer.length < capacity) {
        buffer.push(value);
        return Promise.resolve();
      }
      return park<void, PendingSend<T>>(senders, signal, (w) => ({ ...w, value }));
    },
    recv(signal) {
      if (buffer.length > 0) {
        const value = buffer.shift() as T;
        const sender = senders.shift();
        if (sender) {
          buffer.push(sender.value);
          sender.resolve();
        }
        return Promise.resolve({ done: false, value });
      }
      if (closed) return Promise.resolve({ done: true });
      return park<RecvResult<T>, Waiter<RecvResult<T>>>(receivers, signal, (w) => w);
    },
    close() {
      closed = true;
      for (const r of receivers.splice(0)) r.resolve({ done: true });
      for (const s of senders.splice(0)) s.reject(new ChannelClosedError());
    },
  };
}
