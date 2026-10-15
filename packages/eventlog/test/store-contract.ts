import { randomUUID } from 'node:crypto';
import type { Flow } from '@loopwork/graph';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoopworkEvent, NewEvent } from '../src/events.js';
import { InvalidEventError, RunClosedError, RunExistsError, SeqConflictError, UnknownRunError } from '../src/store.js';
import type { EventStore } from '../src/store.js';

export type StoreHarness = { store: EventStore; dispose(): Promise<void> };
// Every call must return a fresh, empty store. pollMs is a constructor option; now is the store's clock.
export type MakeStore = (opts?: { pollMs?: number; now?: () => Date }) => Promise<StoreHarness>;

const FIXED = '2026-01-01T00:00:00.000Z';
const fixedClock = () => new Date(FIXED);
const tickingClock = () => {
  let t = Date.UTC(2026, 0, 1);
  return () => new Date((t += 1000));
};

const flow = { version: 1, id: 'f', name: 'f', nodes: {}, edges: [] } as Flow;
const created = (): Extract<NewEvent, { type: 'RunCreated' }> => ({ type: 'RunCreated', flow, createdBy: 'cli' });
const started = (attempt: number): NewEvent => ({ type: 'RunStarted', workerId: 'w1', attempt });
const failed = (): NewEvent => ({ type: 'RunFailed', reason: 'internal', message: 'boom' });
const item = (i: number): NewEvent => ({ type: 'ItemEmitted', node: 'src', itemId: `src.out#${i}`, value: i });

const collect = async (it: AsyncIterable<LoopworkEvent>): Promise<LoopworkEvent[]> => {
  const out: LoopworkEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const seqs = (events: LoopworkEvent[]) => events.map((e) => e.seq);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Fails instead of hanging when a subscription does not end.
const within = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`not done within ${ms}ms`)), ms))]);

export function runStoreContract(name: string, makeStore: MakeStore): void {
  describe(`${name} store contract`, () => {
    const open: StoreHarness[] = [];
    const make = async (opts?: Parameters<MakeStore>[0]) => {
      const h = await makeStore(opts);
      open.push(h);
      return h.store;
    };
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.dispose()));
    });

    it('EL-1: create/append/read return events in ascending seq with gapless seq starting at 1', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      expect(await store.append(id, [started(1), item(0)], { expectedSeq: 1 })).toEqual({ lastSeq: 3 });
      expect(await store.append(id, [item(1)], { expectedSeq: 3 })).toEqual({ lastSeq: 4 });
      const events = await collect(store.read(id));
      expect(seqs(events)).toEqual([1, 2, 3, 4]);
      expect(events.map((e) => e.type)).toEqual(['RunCreated', 'RunStarted', 'ItemEmitted', 'ItemEmitted']);
      expect(events.every((e) => e.runId === id)).toBe(true);
    });

    it('EL-1: limit and fromSeq are honored', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [item(0), item(1), item(2), item(3)], { expectedSeq: 1 });
      // fromSeq is inclusive (first seq returned); omitted means from seq 1.
      expect(seqs(await collect(store.read(id, { fromSeq: 3 })))).toEqual([3, 4, 5]);
      expect(seqs(await collect(store.read(id, { limit: 2 })))).toEqual([1, 2]);
      expect(seqs(await collect(store.read(id, { fromSeq: 2, limit: 2 })))).toEqual([2, 3]);
      expect(await collect(store.read(id, { fromSeq: 6 }))).toEqual([]);
    });

    it('EL-1: create fails when runId exists', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      const err = await store.create(id, created()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunExistsError);
      expect(err).toMatchObject({ code: 'E_RUN_EXISTS' });
      expect(seqs(await collect(store.read(id)))).toEqual([1]);
    });

    it('EL-2: stale expectedSeq throws SeqConflictError and writes nothing', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [item(0)], { expectedSeq: 1 });
      for (const expectedSeq of [1, 5]) {
        const err = await store.append(id, [item(1)], { expectedSeq }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SeqConflictError);
        expect(err).toMatchObject({ code: 'E_SEQ_CONFLICT' });
      }
      expect(seqs(await collect(store.read(id)))).toEqual([1, 2]);
      expect((await store.getRun(id))?.lastSeq).toBe(2);
    });

    it('EL-2: a batch with an invalid event writes nothing', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      const bad = { type: 'NotAnEvent' } as unknown as NewEvent;
      const err = await store.append(id, [item(0), bad], { expectedSeq: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidEventError);
      expect(err).toMatchObject({ code: 'E_BAD_EVENT' });
      expect(seqs(await collect(store.read(id)))).toEqual([1]);
      expect((await store.getRun(id))?.lastSeq).toBe(1);
    });

    it('EL-2: appending to an unknown run throws UnknownRunError', async () => {
      const store = await make();
      const err = await store.append(randomUUID(), [item(0)], { expectedSeq: 0 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnknownRunError);
      expect(err).toMatchObject({ code: 'E_RUN_NOT_FOUND' });
    });

    it('EL-4: appends after a terminal event reject with E_RUN_CLOSED', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [started(1), { type: 'RunSucceeded' }], { expectedSeq: 1 });
      // A succeeded run never reopens, even for a higher-attempt RunStarted.
      for (const e of [item(0), started(2)]) {
        const err = await store.append(id, [e], { expectedSeq: 3 }).catch((x: unknown) => x);
        expect(err).toBeInstanceOf(RunClosedError);
        expect(err).toMatchObject({ code: 'E_RUN_CLOSED' });
      }
      expect(seqs(await collect(store.read(id)))).toEqual([1, 2, 3]);
      expect((await store.getRun(id))?.status).toBe('succeeded');
    });

    it('EL-4: explicit-resume RunStarted is accepted on a failed run and status becomes running', async () => {
      const store = await make();
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [started(1), failed()], { expectedSeq: 1 });
      expect((await store.getRun(id))?.status).toBe('failed');
      // Same attempt, or any non-RunStarted event, does not resume.
      for (const e of [started(1), item(0)]) {
        const err = await store.append(id, [e], { expectedSeq: 3 }).catch((x: unknown) => x);
        expect(err).toMatchObject({ code: 'E_RUN_CLOSED' });
      }
      expect(await store.append(id, [started(2)], { expectedSeq: 3 })).toEqual({ lastSeq: 4 });
      expect((await store.getRun(id))?.status).toBe('running');
      await store.append(id, [item(0)], { expectedSeq: 4 });
    });

    it('EL-5: subscribe delivers history then live events in order with no duplicates or gaps and ends on abort', async () => {
      const store = await make({ pollMs: 5 });
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [started(1), item(0)], { expectedSeq: 1 });
      const batches = 15;
      const total = 3 + batches * 2;
      const ac = new AbortController();
      const seen: LoopworkEvent[] = [];
      const reader = (async () => {
        for await (const e of store.subscribe(id, { fromSeq: 1, signal: ac.signal })) {
          seen.push(e);
          if (e.seq === total) ac.abort();
        }
      })();
      // Concurrent appender, interleaved with the reader's polling.
      let last = 3;
      for (let i = 1; i <= batches; i++) {
        ({ lastSeq: last } = await store.append(id, [item(2 * i), item(2 * i + 1)], { expectedSeq: last }));
        await sleep(2);
      }
      await within(reader, 10000);
      expect(seqs(seen)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    }, 20000);

    it('EL-5: subscribe starts at fromSeq (inclusive) and ends when aborted while idle', async () => {
      const store = await make({ pollMs: 5 });
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [item(0), item(1)], { expectedSeq: 1 });
      const ac = new AbortController();
      const seen: number[] = [];
      const reader = (async () => {
        for await (const e of store.subscribe(id, { fromSeq: 3, signal: ac.signal })) seen.push(e.seq);
      })();
      await sleep(50);
      expect(seen).toEqual([3]);
      ac.abort();
      await within(reader);
    });

    it('EL-5: subscribe with an already-aborted signal yields nothing and ends', async () => {
      const store = await make({ pollMs: 5 });
      const id = randomUUID();
      await store.create(id, created());
      const ac = new AbortController();
      ac.abort();
      expect(await within(collect(store.subscribe(id, { fromSeq: 1, signal: ac.signal })))).toEqual([]);
    });

    it('getRun returns the projection row and undefined for an unknown run', async () => {
      const store = await make({ now: fixedClock });
      const id = randomUUID();
      expect(await store.getRun(id)).toBeUndefined();
      await store.create(id, created());
      expect(await store.getRun(id)).toEqual({
        runId: id,
        flowId: 'f',
        flowName: 'f',
        status: 'queued',
        createdAt: FIXED,
        updatedAt: FIXED,
        lastSeq: 1,
      });
      await store.append(id, [started(1)], { expectedSeq: 1 });
      expect(await store.getRun(id)).toMatchObject({ status: 'running', lastSeq: 2 });
    });

    it('stored events carry the ts from the injected clock', async () => {
      const store = await make({ now: fixedClock });
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [item(0)], { expectedSeq: 1 });
      expect((await collect(store.read(id))).map((e) => e.ts)).toEqual([FIXED, FIXED]);
    });

    it('listRuns returns newest first and honors status, limit and before', async () => {
      const store = await make({ now: tickingClock() });
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, c]) await store.create(id, created());
      await store.append(b, [started(1), { type: 'RunSucceeded' }], { expectedSeq: 1 });
      const ids = async (f: Parameters<EventStore['listRuns']>[0]) => (await store.listRuns(f)).map((r) => r.runId);
      expect(await ids({})).toEqual([c, b, a]);
      expect(await ids({ status: 'queued' })).toEqual([c, a]);
      expect(await ids({ status: 'succeeded' })).toEqual([b]);
      expect(await ids({ limit: 2 })).toEqual([c, b]);
      // before is an ISO createdAt cursor: only runs created strictly earlier.
      const rowB = await store.getRun(b);
      if (!rowB) throw new Error('missing run');
      expect(await ids({ before: rowB.createdAt })).toEqual([a]);
    });

    it('events returned by read and subscribe are copies', async () => {
      const store = await make({ pollMs: 5 });
      const id = randomUUID();
      await store.create(id, created());
      await store.append(id, [item(0)], { expectedSeq: 1 });
      const [first, second] = await collect(store.read(id));
      (first as Record<string, unknown>).seq = 99;
      ((first as { flow: Flow }).flow as { name: string }).name = 'mutated';
      (second as Record<string, unknown>).value = 'mutated';
      const again = await collect(store.read(id));
      expect(seqs(again)).toEqual([1, 2]);
      expect((again[0] as { flow: Flow }).flow.name).toBe('f');
      expect((again[1] as { value: unknown }).value).toBe(0);
      const ac = new AbortController();
      for await (const e of store.subscribe(id, { fromSeq: 1, signal: ac.signal })) {
        (e as Record<string, unknown>).seq = 99;
        if (e.type === 'ItemEmitted') ac.abort();
      }
      expect(seqs(await collect(store.read(id)))).toEqual([1, 2]);
    });
  });
}
