import type { Frame } from '@loopwork/graph';

type Backoff = Extract<Frame, { frame: 'retry' }>['backoff'];

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
