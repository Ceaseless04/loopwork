import { EVENT_TYPES } from './events.js';
import type { LoopworkEvent, NewEvent, RunRow, RunStatus } from './events.js';
import { assertAppendAllowed, nextStatus } from './status.js';
import { InvalidEventError, RunExistsError, SeqConflictError, UnknownRunError } from './store.js';
import type { EventStore } from './store.js';

type Run = { row: RunRow; events: LoopworkEvent[] };

/** In-process EventStore. Events are JSON, so stored and returned events are structured clones. */
export class MemoryStore implements EventStore {
  private readonly runs = new Map<string, Run>(); // insertion order = creation order
  private readonly waiters = new Set<() => void>();
  private readonly now: () => Date;
  private readonly pollMs: number;

  constructor(opts: { now?: () => Date; pollMs?: number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.pollMs = opts.pollMs ?? 100;
  }

  async create(runId: string, first: Extract<NewEvent, { type: 'RunCreated' }>): Promise<void> {
    if (this.runs.has(runId)) throw new RunExistsError(`run ${runId} already exists`);
    const ts = this.now().toISOString();
    const row: RunRow = {
      runId,
      flowId: first.flow.id,
      flowName: first.flow.name,
      status: nextStatus(undefined, first),
      createdAt: ts,
      updatedAt: ts,
      lastSeq: 1,
    };
    this.runs.set(runId, { row, events: [structuredClone({ ...first, runId, seq: 1, ts })] });
    this.wake();
  }

  async append(runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }> {
    const run = this.runs.get(runId);
    if (!run) throw new UnknownRunError(`run ${runId} not found`);
    for (const e of events) {
      if (!(EVENT_TYPES as readonly string[]).includes(e.type)) throw new InvalidEventError(`unknown event type ${String(e.type)}`);
    }
    if (opts.expectedSeq !== run.row.lastSeq) {
      throw new SeqConflictError(`expected seq ${opts.expectedSeq}, run is at ${run.row.lastSeq}`);
    }
    const lastAttempt = run.events.reduce((m, e) => (e.type === 'RunStarted' ? Math.max(m, e.attempt) : m), 0);
    assertAppendAllowed(run.row.status, lastAttempt, events);

    const ts = this.now().toISOString();
    let seq = run.row.lastSeq;
    for (const e of events) {
      run.events.push(structuredClone({ ...e, runId, seq: ++seq, ts }));
      run.row.status = nextStatus(run.row.status, e);
    }
    run.row.lastSeq = seq;
    run.row.updatedAt = ts;
    this.wake();
    return { lastSeq: seq };
  }

  async *read(runId: string, opts: { fromSeq?: number; limit?: number } = {}): AsyncIterable<LoopworkEvent> {
    const events = this.runs.get(runId)?.events ?? [];
    const from = Math.max(opts.fromSeq ?? 1, 1) - 1;
    for (const e of events.slice(from, opts.limit === undefined ? undefined : from + opts.limit)) yield structuredClone(e);
  }

  async *subscribe(runId: string, opts: { fromSeq: number; signal: AbortSignal }): AsyncIterable<LoopworkEvent> {
    let next = Math.max(opts.fromSeq, 1);
    while (!opts.signal.aborted) {
      const pending = this.runs.get(runId)?.events.slice(next - 1) ?? [];
      for (const e of pending) {
        next = e.seq + 1;
        yield structuredClone(e);
        if (opts.signal.aborted) return;
      }
      if (pending.length === 0) await this.sleep(opts.signal);
    }
  }

  async getRun(runId: string): Promise<RunRow | undefined> {
    const run = this.runs.get(runId);
    return run && { ...run.row };
  }

  async listRuns(f: { status?: RunStatus; limit?: number; before?: string }): Promise<RunRow[]> {
    const rows = [...this.runs.values()]
      .map((r) => r.row)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId)) // newest first, runId desc tiebreak
      .filter((r) => (f.status === undefined || r.status === f.status) && (f.before === undefined || r.createdAt < f.before));
    return rows.slice(0, f.limit).map((r) => ({ ...r }));
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  // Resolves on the next append, after pollMs, or on abort; always cleans up its timer and listeners.
  private sleep(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      signal.addEventListener('abort', done);
      this.waiters.add(done);
    });
  }
}
