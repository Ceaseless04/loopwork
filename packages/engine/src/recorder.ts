import { SeqConflictError } from '@loopwork/eventlog';
import type { EventStore, NewEvent } from '@loopwork/eventlog';

export interface Recorder {
  /** Buffers; appends when `maxEvents` is reached or `maxMs` after the first buffered event. Ignored once closed or fenced. */
  push(e: NewEvent): void;
  /** Resolves once everything pushed before the call is appended (or dropped because fenced); rejects with a non-conflict store error. */
  flush(): Promise<void>;
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
  /** Called exactly once, on the first SeqConflictError. */
  onFenced: () => void;
}): Recorder {
  let buffer: NewEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve(); // appends run strictly one after another
  let late: { error: unknown } | undefined; // failure of a push/timer-triggered write, surfaced by the next flush()
  let closed = false;
  let fenced = false;
  let lastSeq = o.expectedSeq;

  const write = async (batch: NewEvent[]): Promise<void> => {
    if (fenced || batch.length === 0) return;
    try {
      lastSeq = (await o.store.append(o.runId, batch, { expectedSeq: lastSeq })).lastSeq;
    } catch (error) {
      if (!(error instanceof SeqConflictError)) throw error;
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
    const run = tail.then(() => write(batch));
    tail = run.catch(() => undefined);
    return run;
  };

  const background = (): void => {
    enqueue().catch((error: unknown) => {
      late = { error };
    });
  };

  const flush = async (): Promise<void> => {
    await enqueue();
    if (late) {
      const { error } = late;
      late = undefined;
      throw error;
    }
  };

  return {
    push(e) {
      if (closed || fenced) return;
      buffer.push(e);
      if (buffer.length >= o.maxEvents) return background();
      timer ??= setTimeout(background, o.maxMs);
      timer.unref();
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
    get fenced() {
      return fenced;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
