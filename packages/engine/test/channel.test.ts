import { describe, expect, it } from 'vitest';
import { ChannelClosedError, createChannel } from '../src/channel.js';

/** Tracks whether a promise has settled, without awaiting it. */
function track(p: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  p.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('channel', () => {
  it('channel: send resolves below capacity, blocks at capacity until a recv, and size never exceeds capacity', async () => {
    const ch = createChannel<number>(2);
    await ch.send(1);
    await ch.send(2);
    expect(ch.size).toBe(2);

    const third = ch.send(3);
    const thirdState = track(third);
    await tick();
    expect(thirdState.settled).toBe(false);
    expect(ch.size).toBe(2);

    expect(await ch.recv()).toEqual({ done: false, value: 1 });
    await third;
    expect(ch.size).toBe(2);
    expect(ch.size).toBeLessThanOrEqual(ch.capacity);
  });

  it('channel: delivers in FIFO order, a pending send never loses its item, and recv on empty waits for a later send', async () => {
    const ch = createChannel<number>(1);
    const sends = [1, 2, 3, 4].map((n) => ch.send(n));
    const got: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await ch.recv();
      if (r.done) throw new Error('unexpected done');
      got.push(r.value);
      expect(ch.size).toBeLessThanOrEqual(1);
    }
    await Promise.all(sends);
    expect(got).toEqual([1, 2, 3, 4]);

    const waiting = ch.recv();
    const waitingState = track(waiting);
    await tick();
    expect(waitingState.settled).toBe(false);
    await ch.send(5);
    expect(await waiting).toEqual({ done: false, value: 5 });
  });

  it('channel: close lets buffered items drain then recv is done; send after close rejects ChannelClosedError', async () => {
    const ch = createChannel<string>(3);
    await ch.send('a');
    await ch.send('b');
    ch.close();
    ch.close(); // idempotent
    await expect(ch.send('c')).rejects.toBeInstanceOf(ChannelClosedError);
    expect(await ch.recv()).toEqual({ done: false, value: 'a' });
    expect(await ch.recv()).toEqual({ done: false, value: 'b' });
    expect(await ch.recv()).toEqual({ done: true });

    const empty = createChannel<string>(1);
    const pending = empty.recv();
    empty.close();
    expect(await pending).toEqual({ done: true });

    // close rejects a parked send instead of leaving it hanging
    const full = createChannel<number>(1);
    await full.send(1);
    const parked = full.send(2);
    const parkedState = track(parked);
    full.close();
    await tick();
    expect(parkedState.settled).toBe(true); // fails fast rather than timing out
    await expect(parked).rejects.toBeInstanceOf(ChannelClosedError);
  });

  it('channel: aborting a pending send or recv rejects it with the reason and leaves no waiter behind', async () => {
    const full = createChannel<number>(1);
    await full.send(1);
    const sendAbort = new AbortController();
    const blockedSend = full.send(2, sendAbort.signal);
    sendAbort.abort(new Error('stop send'));
    await expect(blockedSend).rejects.toThrow('stop send');
    // the aborted item is not delivered and a later send/recv still works
    expect(await full.recv()).toEqual({ done: false, value: 1 });
    await full.send(3);
    expect(await full.recv()).toEqual({ done: false, value: 3 });

    const empty = createChannel<number>(1);
    const recvAbort = new AbortController();
    const blockedRecv = empty.recv(recvAbort.signal);
    recvAbort.abort(new Error('stop recv'));
    await expect(blockedRecv).rejects.toThrow('stop recv');
    await empty.send(7); // must buffer, not be handed to the aborted receiver
    expect(empty.size).toBe(1);
    expect(await empty.recv()).toEqual({ done: false, value: 7 });
  });

  it('channel: capacity must be an integer >= 1', () => {
    expect(() => createChannel(0)).toThrow(RangeError);
    expect(() => createChannel(1.5)).toThrow(RangeError);
  });
});
