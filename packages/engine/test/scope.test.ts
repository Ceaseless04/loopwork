import { MemoryStore } from '@loopwork/eventlog';
import { describe, expect, it } from 'vitest';
import { createBuiltins } from '../src/index.js';
import type { Channel } from '../src/channel.js';
import { createRecorder } from '../src/recorder.js';
import type { Item } from '../src/registry.js';
import { createLimiter, type Limiter } from '../src/scheduler.js';
import { createRunScope } from '../src/scope.js';
import { foreachFrame, frameFlow, startRun } from './helpers.js';

/** Runs `src -> F(foreach) -> snk` over `count` items on a bare scope and returns the run's live channel count afterwards. */
async function liveChannelsAfter(count: number): Promise<number> {
  const store = new MemoryStore();
  const def = frameFlow(foreachFrame({ concurrency: 3 }), count);
  const { expectedSeq } = await startRun(store, 'r', def);
  const ctrl = new AbortController();
  const rec = createRecorder({ store, runId: 'r', expectedSeq, maxEvents: 500, maxMs: 50, onFenced: () => {} });
  const channels = new Set<Channel<Item>>();
  const { work } = createRunScope({
    runId: 'r',
    input: undefined,
    registry: createBuiltins(),
    signal: ctrl.signal,
    rec,
    emit: (e) => rec.push(e),
    fail: (_reason, message) => {
      throw new Error(message);
    },
    limiter: createLimiter(64),
    capacity: 64,
    channels,
    nodeLimiters: new Map<string, Limiter>(),
  })({ nodes: def.nodes, edges: def.edges, prefix: '' });
  await Promise.all(work);
  await rec.close();
  return channels.size;
}

describe('createRunScope', () => {
  it('frames: a finished foreach instance disposes its body channels (live channels do not grow with the item count)', async () => {
    // top level: F.in and snk.in (a source has no input channel); each instance's body channel must be gone once it exits
    expect(await liveChannelsAfter(5)).toBe(2);
    expect(await liveChannelsAfter(50)).toBe(2);
  });
});
