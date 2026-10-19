import { MemoryStore } from '@loopwork/eventlog';
import type { NewEvent } from '@loopwork/eventlog';
import type { Flow } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder } from '../src/recorder.js';

const flow = { version: 1, id: 'f', name: 'F', nodes: {}, edges: [] } as Flow;
const ev = (count: number): NewEvent => ({ type: 'SourceCompleted', node: 'n', count });

async function setup(opts: { maxEvents?: number; maxMs?: number; onError?: (error: unknown) => void } = {}) {
  const store = new MemoryStore();
  await store.create('r', { type: 'RunCreated', flow, createdBy: 'cli' });
  const onFenced = vi.fn();
  const rec = createRecorder({ store, runId: 'r', expectedSeq: 1, maxEvents: 3, maxMs: 1000, onFenced, ...opts });
  const read = async () => {
    const out = [];
    for await (const e of store.read('r')) out.push(e);
    return out;
  };
  return { store, rec, onFenced, read };
}

afterEach(() => vi.useRealTimers());

describe('recorder', () => {
  it('recorder: buffers below maxEvents until maxMs, appends a full batch immediately', async () => {
    vi.useFakeTimers();
    const { store, rec } = await setup();
    const append = vi.spyOn(store, 'append');

    rec.push(ev(1));
    rec.push(ev(2));
    await vi.advanceTimersByTimeAsync(999);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![1]).toHaveLength(2);

    rec.push(ev(3));
    rec.push(ev(4));
    rec.push(ev(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]![1]).toHaveLength(3);
  });

  it('recorder: successive batches chain expectedSeq and leave a gapless seq', async () => {
    const { store, rec, read } = await setup({ maxEvents: 2 });
    const append = vi.spyOn(store, 'append');

    for (let i = 1; i <= 5; i++) rec.push(ev(i));
    await rec.flush();

    expect(append.mock.calls.map((c) => c[2].expectedSeq)).toEqual([1, 3, 5]);
    expect(rec.lastSeq).toBe(6);
    const events = await read();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.slice(1).map((e) => (e as { count: number }).count)).toEqual([1, 2, 3, 4, 5]);
  });

  it('recorder: flush() writes pending events in order and serializes concurrent flushes', async () => {
    const { store, rec, read } = await setup({ maxEvents: 1 });
    const real = store.append.bind(store);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await real(...args);
      } finally {
        inFlight--;
      }
    });

    rec.push(ev(1));
    rec.push(ev(2));
    rec.push(ev(3));
    await Promise.all([rec.flush(), rec.flush()]);

    expect(maxInFlight).toBe(1);
    expect((await read()).slice(1).map((e) => (e as { count: number }).count)).toEqual([1, 2, 3]);
  });

  it('recorder: SeqConflictError fences: onFenced once, buffer dropped, later pushes and flushes do nothing', async () => {
    const { store, rec, onFenced, read } = await setup();
    await store.append('r', [ev(99)], { expectedSeq: 1 }); // another writer moves the log

    rec.push(ev(1));
    await rec.flush();
    expect(rec.fenced).toBe(true);
    expect(onFenced).toHaveBeenCalledTimes(1);

    const append = vi.spyOn(store, 'append');
    rec.push(ev(2));
    rec.push(ev(3));
    rec.push(ev(4));
    await rec.flush();
    await rec.close();
    expect(append).not.toHaveBeenCalled();
    expect(onFenced).toHaveBeenCalledTimes(1);
    expect((await read()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('recorder: a non-conflict store error rejects flush() and does not fence', async () => {
    const { store, rec, onFenced } = await setup();
    vi.spyOn(store, 'append').mockRejectedValue(new Error('db down'));

    rec.push(ev(1));
    await expect(rec.flush()).rejects.toThrow('db down');
    expect(rec.fenced).toBe(false);
    expect(onFenced).not.toHaveBeenCalled();

    // a write started by push() itself (batch full) must surface its error on the next flush()
    const auto = await setup({ maxEvents: 1 });
    vi.spyOn(auto.store, 'append').mockRejectedValueOnce(new Error('db down'));
    auto.rec.push(ev(1));
    await expect(auto.rec.flush()).rejects.toThrow('db down');
    expect(auto.rec.fenced).toBe(false);
    expect(auto.onFenced).not.toHaveBeenCalled();
  });

  it('recorder: the first non-conflict store error is sticky: nothing more is appended, flush()/close() keep rejecting', async () => {
    const { store, rec, onFenced, read } = await setup({ maxEvents: 1 });
    const append = vi.spyOn(store, 'append').mockRejectedValueOnce(new Error('db down'));

    rec.push(ev(1)); // its write fails
    rec.push(ev(2));
    rec.push(ev(3));
    await expect(rec.flush()).rejects.toThrow('db down');
    await expect(rec.flush()).rejects.toThrow('db down');
    await expect(rec.close()).rejects.toThrow('db down');

    expect(append).toHaveBeenCalledTimes(1);
    expect((await read()).map((e) => e.seq)).toEqual([1]);
    expect(rec.fenced).toBe(false);
    expect(onFenced).not.toHaveBeenCalled();
  });

  it('recorder: onError is called exactly once, synchronously with the failure, before flush() rejects', async () => {
    const onError = vi.fn();
    const { store, rec } = await setup({ onError });
    vi.spyOn(store, 'append').mockRejectedValue(new Error('db down'));

    rec.push(ev(1));
    await rec.flush().then(
      () => expect.unreachable('flush must reject'),
      () => expect(onError).toHaveBeenCalledTimes(1), // already called by the time the rejection is observed
    );
    await expect(rec.flush()).rejects.toThrow('db down');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error('db down'));
  });

  it('recorder: close() flushes, then ignores later pushes', async () => {
    const { rec, read } = await setup();

    rec.push(ev(1));
    await rec.close();
    expect((await read()).map((e) => e.seq)).toEqual([1, 2]); // close() itself wrote it
    rec.push(ev(2));
    await rec.flush();

    expect((await read()).map((e) => e.seq)).toEqual([1, 2]);
    expect(rec.lastSeq).toBe(2);
  });
});
