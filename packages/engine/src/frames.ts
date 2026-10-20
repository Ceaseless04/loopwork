import type { NewEvent } from '@loopwork/eventlog';
import type { FlowNode, Frame, JsonValue } from '@loopwork/graph';
import type { Recorder } from './recorder.js';
import type { Item } from './registry.js';

type Backoff = Extract<Frame, { frame: 'retry' }>['backoff'];
/** The nearest enclosing retry frame's policy, passed down to every body step (including inside nested foreach bodies). */
export type RetryScope = {
  maxAttempts: number;
  backoff: Backoff;
  /** Present for `emit-error`: marks the owning instance exhausted (first message wins) instead of failing the run. */
  exhaust?: (message: string) => void;
};

const MAX_BACKOFF_MS = 60_000;

/** Delay before retry `attempt` (1-based): `fixed` is `baseMs`; `exponential` doubles per attempt, capped at 60s. */
export function backoffMs(policy: Backoff, attempt: number): number {
  return policy.kind === 'fixed' ? policy.baseMs : Math.min(policy.baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Resolves after `ms`; rejects with `signal.reason` (clearing the timer) if `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One live frame instance (one input item), keyed by its item id in the frame's `instances` map. */
export type Instance = {
  itemId: string;
  value: JsonValue;
  iteration: number;
  elapsedMs: number;
  timer?: ReturnType<typeof setTimeout>;
  exhausted?: { message: string };
};
/** What a frame instance needs from the run: the recorder, the gated `emit` and the abort signal. */
export type FrameHost = { rec: Recorder; emit(e: NewEvent): void; signal: AbortSignal; send(port: string, item: Item): Promise<void>; fail(reason: 'budget', message: string, node: string): void };

/** Engine-clock duration for IterationEnded.elapsedMs: bookkeeping that is never replayed, so reading the clock here is allowed. */
const elapsed = (t0: number): number => Date.now() - t0;

/**
 * Lifecycle of one foreach or retry instance (write-ahead: every event is logged before its effect). `runBody` enters the
 * body and resolves when its pools have drained. A stopped run starts and finishes nothing.
 */
export async function runInstance(
  h: FrameHost,
  f: { id: string; node: Extract<FlowNode, { kind: 'frame' }>; instances: Map<string, Instance> },
  item: Item,
  runBody: (inst: Instance) => Promise<void>,
  iteration = 1,
  loggedElapsedMs = 0, // time already spent before a resume, so the time budget keeps counting across restarts
): Promise<void> {
  await h.rec.ready();
  if (h.signal.aborted) return;
  const inst: Instance = { itemId: item.itemId, value: item.value, iteration, elapsedMs: 0 };
  f.instances.set(inst.itemId, inst);
  try {
    const t0 = Date.now();
    h.emit({ type: 'FrameEntered', node: f.id, itemId: inst.itemId, frame: f.node.frame });
    h.emit({ type: 'IterationStarted', node: f.id, itemId: inst.itemId, iteration });
    const limit = f.node.budgets.maxDurationMs;
    // Log-then-stop in one tick: BudgetExceeded is emitted before fail() aborts the run (emit drops after the abort).
    inst.timer = setTimeout(() => {
      if (h.signal.aborted) return;
      h.emit({ type: 'BudgetExceeded', node: f.id, itemId: inst.itemId, budget: 'time', limit, used: loggedElapsedMs + elapsed(t0) });
      h.fail('budget', `frame "${f.id}" exceeded its time budget (maxDurationMs=${limit})`, f.id);
    }, limit - loggedElapsedMs);
    await runBody(inst);
    if (h.signal.aborted) return;
    inst.elapsedMs = elapsed(t0);
    h.emit({ type: 'IterationEnded', node: f.id, itemId: inst.itemId, iteration, elapsedMs: inst.elapsedMs });
    if (inst.exhausted) {
      const error = { itemId: `${inst.itemId}>${f.id}.error#0`, value: { message: inst.exhausted.message, item: inst.value } };
      h.emit({ type: 'FrameExited', node: f.id, itemId: inst.itemId, reason: 'retries-exhausted', outputs: [{ port: 'error', ...error }] });
      clearTimeout(inst.timer); // already exited: a breach while the error send is blocked must not log BudgetExceeded
      await h.send('error', error); // write-ahead: FrameExited is logged before the error item is delivered
      return;
    }
    h.emit({ type: 'FrameExited', node: f.id, itemId: inst.itemId, reason: f.node.frame === 'retry' ? 'success' : 'input-done' });
  } finally {
    clearTimeout(inst.timer);
    f.instances.delete(inst.itemId);
  }
}
