import type { LoopworkEvent, NewEvent, RunStatus } from './events.js';
import { InvalidEventError, RunClosedError } from './store.js';

export function nextStatus(current: RunStatus | undefined, e: NewEvent | LoopworkEvent): RunStatus {
  switch (e.type) {
    case 'RunCreated':
      return 'queued';
    case 'RunStarted':
      return 'running';
    case 'RunSucceeded':
      return 'succeeded';
    case 'RunFailed':
      return 'failed';
    case 'RunCancelled':
      return 'cancelled';
    default:
      if (current === undefined) throw new InvalidEventError(`${e.type} before RunCreated`);
      return current;
  }
}

// Walks the batch in order, simulating status. Only a RunStarted with a higher attempt reopens a failed run.
export function assertAppendAllowed(current: RunStatus, lastAttempt: number, events: NewEvent[]): void {
  let status = current;
  let last = lastAttempt;
  for (const e of events) {
    if (e.type === 'RunCreated') throw new InvalidEventError('RunCreated cannot be appended to an existing run');
    const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (terminal && !(status === 'failed' && e.type === 'RunStarted' && e.attempt > last)) {
      throw new RunClosedError(`run is ${status}; cannot append ${e.type}`);
    }
    if (e.type === 'RunStarted') last = Math.max(last, e.attempt);
    status = nextStatus(status, e);
  }
}
