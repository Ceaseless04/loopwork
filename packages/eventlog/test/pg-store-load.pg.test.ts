// Postgres-only criteria over PgStore: EL-3 (append race), EL-8 (bulk append time), EL-10 (constant-memory reads).
//
// EL-10: the property is size-independent (a page query returns at most pageSize rows, whatever the run length), so it is
// asserted on a 50,321-event run with pageSize 1,000. The spec's 1M-event figure is NOT materialised, to keep the pg stage
// short; a reviewer who wants it can raise N_READ below. 50,321 is deliberately not a multiple of pageSize, so the page
// count is exactly ceil(n / pageSize) (a multiple would cost one extra, empty probe page).
// EL-8 measurements live in docs/develop/measurements/event-log.md.
import { randomUUID } from 'node:crypto';
import type { Flow } from '@loopwork/graph';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PgStore } from '../src/pg-store.js';
import type { NewEvent } from '../src/events.js';
import { SeqConflictError } from '../src/store.js';
import { withTestSchema } from './pg-helper.js';

type Opened = { store: PgStore; pool: Pool; dispose(): Promise<void> };

const flow = { version: 1, id: 'f', name: 'F', nodes: {}, edges: [] } as Flow;
const first = { type: 'RunCreated', flow, createdBy: 'cli' } as const;
const item = (i: number): NewEvent => ({ type: 'ItemEmitted', node: 'src', itemId: `src.out#${i}`, value: i });

describe('PgStore load and concurrency (Postgres)', () => {
  const opened: Opened[] = [];
  // Fresh schema + migrations; the pool is warmed (8 connections) so racing appenders really overlap.
  const open = async (opts?: { pageSize?: number }): Promise<Opened> => {
    const t = await withTestSchema();
    const o: Opened = { store: new PgStore(t.pool, opts), pool: t.pool, dispose: () => t.dispose() };
    opened.push(o);
    await migrate(t.pool);
    const clients = await Promise.all(Array.from({ length: 8 }, () => t.pool.connect()));
    for (const c of clients) c.release();
    return o;
  };
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((o) => o.dispose()));
  });

  // Appends `total` ItemEmitted events after RunCreated in batches of 500 and returns the run's last seq.
  const fill = async (store: PgStore, id: string, total: number): Promise<number> => {
    await store.create(id, first);
    let last = 1;
    for (let done = 0; done < total; ) {
      const n = Math.min(500, total - done);
      last = (await store.append(id, Array.from({ length: n }, (_, i) => item(done + i)), { expectedSeq: last })).lastSeq;
      done += n;
    }
    return last;
  };

  it('EL-3: two concurrent appenders with the same expectedSeq, exactly one succeeds', async () => {
    const { store } = await open();
    const id = randomUUID();
    await store.create(id, first);
    const rounds = 50;
    for (let r = 0; r < rounds; r++) {
      const expectedSeq = r + 1;
      const res = await Promise.allSettled([store.append(id, [item(r)], { expectedSeq }), store.append(id, [item(r)], { expectedSeq })]);
      const ok = res.filter((x) => x.status === 'fulfilled');
      const bad = res.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
      expect(ok, `round ${r}`).toHaveLength(1);
      expect(bad, `round ${r}`).toHaveLength(1);
      expect(bad[0]!.reason).toBeInstanceOf(SeqConflictError);
    }
    const seqs: number[] = [];
    for await (const e of store.read(id)) seqs.push(e.seq);
    expect(seqs).toEqual(Array.from({ length: rounds + 1 }, (_, i) => i + 1));
    expect((await store.getRun(id))?.lastSeq).toBe(rounds + 1);
  });

  it('EL-8: appending 100k events in batches of 500 completes in under 20 s', async () => {
    const { store } = await open();
    const t0 = performance.now();
    const last = await fill(store, randomUUID(), 100_000 - 1); // RunCreated + 99,999 items = 100k events
    const ms = performance.now() - t0;
    expect(last).toBe(100_000);
    expect(ms).toBeLessThan(20_000);
  }, 120_000);

  it('EL-10: reading a long run uses constant memory', async () => {
    const pageSize = 1_000;
    const n = 50_321;
    const { store, pool } = await open({ pageSize });
    const id = randomUUID();
    expect(await fill(store, id, n - 1)).toBe(n);

    // Spy on the events-page queries (PgStore reads through pool.query); no hook in production code.
    const pages: number[] = [];
    const sql: string[] = [];
    const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<{ rows: unknown[] }>;
    (pool as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const res = await realQuery(...a);
      if (typeof a[0] === 'string' && /from events/i.test(a[0])) {
        sql.push(a[0]);
        pages.push(res.rows.length);
      }
      return res;
    };

    let count = 0;
    for await (const e of store.read(id)) {
      count++;
      expect(e.seq).toBe(count);
    }
    expect(count).toBe(n);
    expect(Math.max(...pages)).toBeLessThanOrEqual(pageSize);
    expect(pages).toHaveLength(Math.ceil(n / pageSize));
    expect(pages.reduce((a, b) => a + b, 0)).toBe(n);
    expect(sql.every((s) => !/offset/i.test(s))).toBe(true);

    // A consumer that stops mid-iteration (inside the second page) triggers no further page fetch.
    pages.length = 0;
    let seen = 0;
    for await (const e of store.read(id)) {
      seen = e.seq;
      if (seen === pageSize + pageSize / 2) break;
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(pages).toEqual([pageSize, pageSize]);
  }, 120_000);
});
