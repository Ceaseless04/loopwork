import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { EVENT_TYPES } from './events.js';
import type { LoopworkEvent, NewEvent, RunRow, RunStatus } from './events.js';
import { assertAppendAllowed, nextStatus } from './status.js';
import { InvalidEventError, RunExistsError, SeqConflictError, UnknownRunError } from './store.js';
import type { EventStore } from './store.js';

// Non-uuid run ids never reach Postgres (it would raise 22P02): they are unknown runs, or invalid on create.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// bigint columns arrive as strings.
const num = (v: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${v} is not a safe integer`);
  return n;
};

type RunDbRow = { run_id: string; flow_id: string; flow_name: string; status: RunStatus; created_at: Date; updated_at: Date; last_seq: string };
type EventDbRow = { seq: string; ts: Date; type: string; payload: object };

const toRun = (r: RunDbRow): RunRow => ({
  runId: r.run_id,
  flowId: r.flow_id,
  flowName: r.flow_name,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  lastSeq: num(r.last_seq),
});

const INSERT_EVENTS =
  'insert into events (run_id, seq, ts, type, payload) select $1::uuid, u.seq, $2::timestamptz, u.type, u.payload::jsonb from unnest($3::bigint[], $4::text[], $5::text[]) as u(seq, type, payload)';

/** Postgres EventStore. Every write is one transaction; appends serialize on the run's row lock. */
export class PgStore implements EventStore {
  private readonly pageSize: number;
  private readonly pollMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    opts: { pageSize?: number; pollMs?: number; now?: () => Date } = {},
  ) {
    this.pageSize = opts.pageSize ?? 5000;
    this.pollMs = opts.pollMs ?? 100;
    this.now = opts.now ?? (() => new Date());
  }

  async create(runId: string, first: Extract<NewEvent, { type: 'RunCreated' }>): Promise<void> {
    if (!UUID.test(runId)) throw new InvalidEventError(`run id ${runId} is not a uuid`);
    const ts = this.now().toISOString();
    await this.tx(async (c) => {
      try {
        await c.query('insert into runs (run_id, flow_id, flow_name, status, created_at, updated_at, last_seq) values ($1, $2, $3, $4, $5, $5, 1)', [
          runId,
          first.flow.id,
          first.flow.name,
          nextStatus(undefined, first),
          ts,
        ]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new RunExistsError(`run ${runId} already exists`);
        throw e;
      }
      await c.query(INSERT_EVENTS, [runId, ts, [1], [first.type], [payloadOf(first)]]);
    });
  }

  async append(runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }> {
    if (!UUID.test(runId)) throw new UnknownRunError(`run ${runId} not found`);
    const ts = this.now().toISOString();
    return this.tx(async (c) => {
      const run = (await c.query<{ status: RunStatus; last_seq: string }>('select status, last_seq from runs where run_id = $1 for update', [runId])).rows[0];
      if (!run) throw new UnknownRunError(`run ${runId} not found`);
      for (const e of events) {
        if (!(EVENT_TYPES as readonly string[]).includes(e.type)) throw new InvalidEventError(`unknown event type ${String(e.type)}`);
      }
      const lastSeq = num(run.last_seq);
      if (opts.expectedSeq !== lastSeq) throw new SeqConflictError(`expected seq ${opts.expectedSeq}, run is at ${lastSeq}`);
      // A separate statement, so it sees events committed by any appender we waited on.
      const attempt = await c.query<{ n: number }>(
        "select coalesce(max((payload->>'attempt')::int), 0) as n from events where run_id = $1 and type = 'RunStarted'",
        [runId],
      );
      assertAppendAllowed(run.status, attempt.rows[0]?.n ?? 0, events);

      const status = events.reduce<RunStatus>(nextStatus, run.status);
      const newLast = lastSeq + events.length;
      await c.query(INSERT_EVENTS, [
        runId,
        ts,
        events.map((_, i) => lastSeq + 1 + i),
        events.map((e) => e.type),
        events.map(payloadOf),
      ]);
      await c.query('update runs set status = $2, last_seq = $3, updated_at = $4 where run_id = $1', [runId, status, newLast, ts]);
      return { lastSeq: newLast };
    });
  }

  async *read(runId: string, opts: { fromSeq?: number; limit?: number } = {}): AsyncIterable<LoopworkEvent> {
    if (!UUID.test(runId)) return;
    let from = Math.max(opts.fromSeq ?? 1, 1);
    let left = opts.limit ?? Infinity;
    while (left > 0) {
      const size = Math.min(this.pageSize, left);
      // Keyset page on the (run_id, seq) primary key.
      const { rows } = await this.pool.query<EventDbRow>('select seq, ts, type, payload from events where run_id = $1 and seq >= $2 order by seq limit $3', [
        runId,
        from,
        size,
      ]);
      for (const r of rows) yield { ...r.payload, type: r.type, runId, seq: num(r.seq), ts: r.ts.toISOString() } as LoopworkEvent;
      if (rows.length < size) return;
      from = num(rows[rows.length - 1]!.seq) + 1;
      left -= rows.length;
    }
  }

  async *subscribe(runId: string, opts: { fromSeq: number; signal: AbortSignal }): AsyncIterable<LoopworkEvent> {
    let next = Math.max(opts.fromSeq, 1);
    while (!opts.signal.aborted) {
      let seen = 0;
      for await (const e of this.read(runId, { fromSeq: next })) {
        next = e.seq + 1;
        seen++;
        yield e;
        if (opts.signal.aborted) return;
      }
      // Abortable sleep: rejects (and cleans up its timer and listener) as soon as the signal aborts.
      if (seen === 0) await sleep(this.pollMs, undefined, { signal: opts.signal }).catch(() => undefined);
    }
  }

  async getRun(runId: string): Promise<RunRow | undefined> {
    if (!UUID.test(runId)) return undefined;
    const { rows } = await this.pool.query<RunDbRow>('select * from runs where run_id = $1', [runId]);
    return rows[0] && toRun(rows[0]);
  }

  async listRuns(f: { status?: RunStatus; limit?: number; before?: string }): Promise<RunRow[]> {
    const { rows } = await this.pool.query<RunDbRow>(
      `select * from runs
       where ($1::text is null or status = $1) and ($2::timestamptz is null or created_at < $2)
       order by created_at desc, run_id desc limit $3::int`,
      [f.status ?? null, f.before ?? null, f.limit ?? null],
    );
    return rows.map(toRun);
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      try {
        const out = await fn(c);
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => undefined); // never mask the original error
        throw e;
      }
    } finally {
      c.release();
    }
  }
}

// The stored payload is everything except the columns runId/seq/ts/type.
function payloadOf(e: NewEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'type')));
}
