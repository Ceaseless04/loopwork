import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, sleep } from '../src/frames.js';

describe('frames: retry primitives', () => {
  afterEach(() => vi.useRealTimers());

  it('frames: backoffMs and sleep', async () => {
    expect([1, 2, 5].map((a) => backoffMs({ kind: 'fixed', baseMs: 1000 }, a))).toEqual([1000, 1000, 1000]);
    const exp = { kind: 'exponential', baseMs: 1000 } as const;
    expect([1, 2, 3].map((a) => backoffMs(exp, a))).toEqual([1000, 2000, 4000]);
    expect(backoffMs(exp, 20)).toBe(60_000);

    vi.useFakeTimers();
    const ac = new AbortController();
    let done = false;
    const p = sleep(500, ac.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(vi.getTimerCount()).toBe(0);

    const reason = new Error('stop');
    const aborted = sleep(500, ac.signal);
    const rejected = expect(aborted).rejects.toBe(reason);
    ac.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(sleep(500, ac.signal)).rejects.toBe(reason); // already aborted
    expect(vi.getTimerCount()).toBe(0);
  });
});
