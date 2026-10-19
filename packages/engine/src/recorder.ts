import { SeqConflictError } from '@loopwork/eventlog';
import type { EventStore, NewEvent } from '@loopwork/eventlog';

export interface Recorder {
  /** Buffers; appends when `maxEvents` is reached or `maxMs` after the first buffered event. Ignored once closed or fenced. */
  push(e: NewEvent): void;
  /** Resolves once everything pushed before the call is appended (or dropped because fenced); rejects with the first non-conflict store error, every time. */
  flush(): Promise<void>;
  /** Resolves at once while fewer than `maxQueuedBatches` batches await their write, else when one completes; rejects with the sticky store error once failed. */
  ready(): Promise<void>;
  /** Flushes, then ignores later pushes. */
  close(): Promise<void>;
  readonly fenced: boolean;
  /** Last seq returned by the store (initially `expectedSeq`). */
  readonly lastSeq: number;
}

export function createRecorder(o: {
  store: EventStore;
  runId: string;
  expectedSeq: number;
  maxEvents: number;
  maxMs: number;
  /** Producers should `ready()` before pushing; at most this many batches are queued-but-unwritten before it waits. Default 4. */
  maxQueuedBatches?: number;
  /** Called exactly once, on the first SeqConflictError. */
  onFenced: () => void;
  /** Called exactly once, on the first non-conflict store error (which flush()/close() then rethrow). */
  onError?: (error: unknown) => void;
}): Recorder {
  let buffer: NewEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve(); // appends run strictly one after another
  let failed: { error: unknown } | undefined; // first non-conflict store error: sticky, so the log never gets holes
  let queued = 0; // batches enqueued whose write has not finished
  let waiters: (() => void)[] = []; // ready() callers parked while over the bound
  const wake = (): void => {
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  };
  let closed = false;
  let fenced = false;
  let lastSeq = o.expectedSeq;

  const write = async (batch: NewEvent[]): Promise<void> => {
    if (failed) throw failed.error;
    if (fenced || batch.length === 0) return;
    try {
      lastSeq = (await o.store.append(o.runId, batch, { expectedSeq: lastSeq })).lastSeq;
    } catch (error) {
      if (!(error instanceof SeqConflictError)) {
        failed = { error };
        o.onError?.(error);
        throw error;
      }
      fenced = true;
      buffer = [];
      clearTimeout(timer);
      timer = undefined;
      o.onFenced();
    }
  };

  /** Takes the current buffer and queues its write behind earlier ones. */
  const enqueue = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const batch = buffer;
    buffer = [];
    queued++;
    const run = tail.then(() => write(batch)).finally(() => {
      queued--;
      wake();
    });
    tail = run.catch(() => undefined);
    return run;
  };

  const background = (): void => {
    enqueue().catch(() => undefined); // already stored in `failed`; surfaced by flush()/close()
  };

  return {
    push(e) {
      if (closed || fenced || failed) return;
      buffer.push(e);
      if (buffer.length >= o.maxEvents) return background();
      if (!timer) {
        timer = setTimeout(background, o.maxMs);
        timer.unref();
      }
    },
    async ready() {
      while (queued >= (o.maxQueuedBatches ?? 4) && !fenced && !failed) await new Promise<void>((resolve) => waiters.push(resolve));
      if (failed) throw failed.error;
    },
    flush: enqueue,
    async close() {
      closed = true;
      await enqueue();
    },
    get fenced() {
      return fenced;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
