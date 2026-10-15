import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { PgStore } from '../src/pg-store.js';
import { InvalidEventError, UnknownRunError } from '../src/store.js';
import { withTestSchema } from './pg-helper.js';
import { runStoreContract } from './store-contract.js';

// Fresh schema + migrations per store, so every contract case starts with empty tables.
const makeStore = async (opts?: { pollMs?: number; now?: () => Date }) => {
  const t = await withTestSchema();
  try {
    await migrate(t.pool);
  } catch (e) {
    await t.dispose();
    throw e;
  }
  return { store: new PgStore(t.pool, opts), dispose: () => t.dispose() };
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
    const { store, dispose } = await makeStore();
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
