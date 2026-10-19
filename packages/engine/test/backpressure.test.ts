import type { NewEvent } from '@loopwork/eventlog';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun } from '../src/index.js';
import { DiscardStore } from './discard-store.js';
import { linearFlow } from './helpers.js';

const CAPACITY = 4;
const MAP_K = 2;
const SINK_K = 1;

/** Per edge: emitted (logged by the producer) minus consumed (StepStarted of the consumer), tracked as events are appended. */
function gapTally() {
  const gap = { srcToMap: 0, mapToSink: 0 };
  const peak = { srcToMap: 0, mapToSink: 0 };
  const bump = (edge: keyof typeof gap, by: number): void => {
    gap[edge] += by;
    peak[edge] = Math.max(peak[edge], gap[edge]);
  };
  const onAppend = (events: NewEvent[]): void => {
    for (const e of events) {
      if (e.type === 'ItemEmitted' && e.node === 'src') bump('srcToMap', 1);
      else if (e.type === 'StepStarted' && e.attempt === 1 && e.node === 'm') bump('srcToMap', -1);
      else if (e.type === 'StepSucceeded' && e.node === 'm') bump('mapToSink', e.outputs.length);
      else if (e.type === 'StepStarted' && e.attempt === 1 && e.node === 'snk') bump('mapToSink', -1);
    }
  };
  return { gap, peak, onAppend };
}

describe('executeRun backpressure', () => {
  it('EC-2: with a sink slower than the source the emitted-minus-consumed gap never exceeds channelCapacity + concurrency + 1', async () => {
    const registry = createBuiltins();
    registry.sink('slow', async () => {
      await new Promise<void>((resolve) => setImmediate(resolve)); // a macrotask per item: the sink is far slower than the microtask-speed source
    });
    const def = linearFlow({
      source: { fn: 'range', params: { count: 2000 } },
      maps: [{ id: 'm', fn: 'identity', concurrency: MAP_K }],
      sink: { fn: 'slow', concurrency: SINK_K },
    });
    const { gap, peak, onAppend } = gapTally();
    const store = new DiscardStore(onAppend);
    await store.create('r', { type: 'RunCreated', flow: def, createdBy: 'cli' });

    const outcome = await executeRun({
      runId: 'r',
      store,
      registry,
      signal: new AbortController().signal,
      workerId: 'w1',
      expectedSeq: 1,
      channelCapacity: CAPACITY,
    });

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(gap).toEqual({ srcToMap: 0, mapToSink: 0 });
    // upper side: the write-ahead bound; a producer that ignores backpressure (unbounded channel) blows through it
    expect(peak.srcToMap).toBeLessThanOrEqual(CAPACITY + MAP_K + 1);
    // lower side: a full channel is actually reached, so a channel smaller than channelCapacity fails here
    expect(peak.srcToMap).toBeGreaterThanOrEqual(CAPACITY);
    // map-fed edge: the map logs StepSucceeded before sending, so each of its workers can have one logged item parked
    expect(peak.mapToSink).toBeLessThanOrEqual(CAPACITY + SINK_K + MAP_K);
    expect(peak.mapToSink).toBeGreaterThanOrEqual(CAPACITY);
  });
});
