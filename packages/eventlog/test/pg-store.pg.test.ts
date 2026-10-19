import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Flow } from '@loopwork/graph';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PgStore } from '../src/pg-store.js';
import type { LoopworkEvent, NewEvent } from '../src/events.js';
import { InvalidEventError, UnknownRunError } from '../src/store.js';
import { withTestSchema } from './pg-helper.js';
import { runStoreContract } from './store-contract.js';

type Opened = { store: PgStore; pool: Pool; dispose(): Promise<void> };

// Fresh schema + migrations per store, so every contract case starts with empty tables.
// The pool is warmed (8 connections) so racing appenders really overlap: without it they connect cold, one after the
// other, and a missing row lock would go unnoticed. onPool runs before the first connection is made.
async function open(opts?: { pageSize?: number; pollMs?: number; now?: () => Date }, onPool?: (pool: Pool) => void): Promise<Opened> {
  const t = await withTestSchema();
  try {
    onPool?.(t.pool);
    await migrate(t.pool);
    const clients = await Promise.all(Array.from({ length: 8 }, () => t.pool.connect()));
    for (const c of clients) c.release();
  } catch (e) {
    await t.dispose();
    throw e;
  }
  return { store: new PgStore(t.pool, opts), pool: t.pool, dispose: () => t.dispose() };
}

const makeStore = async (opts?: { pollMs?: number; now?: () => Date }) => {
  const { store, dispose } = await open(opts);
  return { store, dispose };
};

runStoreContract('PgStore', makeStore, { el6Seeds: 25, timeoutMs: 60_000 });

describe('PgStore', () => {
  it('EL-6: fold.ts and status.ts do not import pg', async () => {
    for (const f of ['fold.ts', 'status.ts']) {
      const src = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from\s+['"]pg['"]|require\(\s*['"]pg['"]|import\(\s*['"]pg['"]/);
    }
  });

  // Pinned: a non-uuid runId never leaks a raw pg 22P02. Reads treat it like any unknown run (same as
  // MemoryStore: getRun undefined, read empty, append UnknownRunError); create rejects it with InvalidEventError.
  it('EL-1: a non-uuid runId is an unknown run for getRun/read/append and InvalidEventError for create', async () => {
    const { store, dispose } = await open();
    try {
      const flow = { version: 1, id: 'f', name: 'F', nodes: {}, edges: [] } as Flow;
      const bad = 'not-a-uuid';
      expect(await store.getRun(bad)).toBeUndefined();
      const read: unknown[] = [];
      for await (const e of store.read(bad)) read.push(e);
      expect(read).toEqual([]);
      const appended = await store.append(bad, [{ type: 'RunStarted', workerId: 'w', attempt: 1 }], { expectedSeq: 1 }).catch((e: unknown) => e);
      expect(appended).toBeInstanceOf(UnknownRunError);
      const createdErr = await store.create(bad, { type: 'RunCreated', flow, createdBy: 'cli' }).catch((e: unknown) => e);
      expect(createdErr).toBeInstanceOf(InvalidEventError);
      expect(createdErr).toMatchObject({ code: 'E_BAD_EVENT' });
      // a well-formed uuid still works afterwards on the same store
      const id = randomUUID();
      await store.create(id, { type: 'RunCreated', flow, createdBy: 'cli' });
      expect(await store.getRun(id)).toMatchObject({ runId: id, lastSeq: 1 });
    } finally {
      await dispose();
    }
  });
});

describe('PgStore (Postgres specifics)', () => {
  const opened: Opened[] = [];
  const openTracked = async (...args: Parameters<typeof open>) => {
    const o = await open(...args);
    opened.push(o);
    return o;
  };
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((o) => o.dispose()));
  });

  const flow = { version: 1, id: 'f', name: 'F', nodes: {}, edges: [] } as Flow;
  const first = { type: 'RunCreated', flow, createdBy: 'cli' } as const;
  const item = (i: number): NewEvent => ({ type: 'ItemEmitted', node: 'src', itemId: `src.out#${i}`, value: i });
  const seqsOf = async (it: AsyncIterable<LoopworkEvent>): Promise<number[]> => {
    const out: number[] = [];
    for await (const e of it) out.push(e.seq);
    return out;
  };

  // Pool clients lose pg-pool's idle error listener on checkout, so PgStore must attach its own for the duration of a
  // transaction. emit('error') throws when nobody listens (this is what kills a process on a real connection loss), so
  // the patched query records whether a listener was present instead of crashing the worker. Either outcome of the
  // append (it completes, or rejects with an Error) is acceptable; the store must stay usable.
  it('F1: a connection error emitted on the checked-out client during append is handled and the store keeps working', async () => {
    let armed = false;
    let emitted: 'handled' | 'unhandled' | undefined;
    const { store, pool } = await openTracked({}, (p) => {
      p.on('connect', (client: PoolClient) => {
        const realQuery = client.query.bind(client) as (...a: unknown[]) => unknown;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
          if (armed && emitted === undefined && typeof a[0] === 'string' && /for update/i.test(a[0])) {
            try {
              client.emit('error', new Error('boom'));
              emitted = 'handled';
            } catch {
              emitted = 'unhandled';
            }
          }
          return realQuery(...a);
        };
      });
    });
    const id = randomUUID();
    await store.create(id, first);
    const baseline = pool.totalCount;
    armed = true;
    const outcome = await store.append(id, [item(0)], { expectedSeq: 1 }).then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(emitted).toBe('handled');
    if (!(outcome instanceof Error)) expect(outcome).toEqual({ lastSeq: 2 });
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.totalCount).toBeLessThanOrEqual(baseline);
    const row = await store.getRun(id);
    if (!row) throw new Error('missing run');
    expect(await store.append(id, [item(1)], { expectedSeq: row.lastSeq })).toEqual({ lastSeq: row.lastSeq + 1 });
  });

  it('EL-1: read pages by keyset across page boundaries (pageSize 3): every seq once, in order, limit and fromSeq across a boundary', async () => {
    const { store } = await openTracked({ pageSize: 3 });
    for (const n of [7, 6]) {
      const id = randomUUID();
      await store.create(id, first);
      await store.append(id, Array.from({ length: n - 1 }, (_, i) => item(i)), { expectedSeq: 1 });
      const all = Array.from({ length: n }, (_, i) => i + 1);
      expect(await seqsOf(store.read(id))).toEqual(all);
      expect(await seqsOf(store.read(id, { limit: 4 }))).toEqual([1, 2, 3, 4]);
      expect(await seqsOf(store.read(id, { fromSeq: 3, limit: 4 }))).toEqual([3, 4, 5, 6]);
      expect(await seqsOf(store.read(id, { fromSeq: 4 }))).toEqual(all.slice(3));
    }
  });

  it('EL-1: a last_seq beyond 2^53 makes getRun throw a RangeError', async () => {
    const { store, pool } = await openTracked();
    const id = randomUUID();
    await pool.query(
      "insert into runs (run_id, flow_id, flow_name, status, created_at, updated_at, last_seq) values ($1, 'f', 'F', 'queued', now(), now(), 9007199254740993)",
      [id],
    );
    await expect(store.getRun(id)).rejects.toBeInstanceOf(RangeError);
  });
});
