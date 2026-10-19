import { SeqConflictError, type EventStore, type LoopworkEvent, type NewEvent, type RunRow } from '@loopwork/eventlog';

type Created = Extract<NewEvent, { type: 'RunCreated' }>;

/**
 * Test-only EventStore that keeps just `RunCreated` and `lastSeq`: appended events are handed to `onAppend` and dropped,
 * so a run's memory does not grow with its event count. `append` fences on `expectedSeq` like the real stores.
 */
export class DiscardStore implements EventStore {
  private created: LoopworkEvent | undefined;
  private lastSeq = 0;

  constructor(private readonly onAppend: (events: NewEvent[]) => void = () => {}) {}

  async create(runId: string, first: Created): Promise<void> {
    if (this.created) throw new Error(`run ${runId} already exists`);
    this.created = { ...first, runId, seq: 1, ts: new Date().toISOString() };
    this.lastSeq = 1;
  }

  async append(_runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }> {
    if (opts.expectedSeq !== this.lastSeq) throw new SeqConflictError(`expected seq ${opts.expectedSeq}, run is at ${this.lastSeq}`);
    this.onAppend(events);
    this.lastSeq += events.length;
    return { lastSeq: this.lastSeq };
  }

  async *read(): AsyncIterable<LoopworkEvent> {
    if (this.created) yield this.created;
  }

  subscribe(): AsyncIterable<LoopworkEvent> {
    throw new Error('DiscardStore does not support subscribe');
  }

  async getRun(): Promise<RunRow | undefined> {
    return undefined;
  }

  async listRuns(): Promise<RunRow[]> {
    return [];
  }
}
