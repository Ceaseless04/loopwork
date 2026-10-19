// Worker entry for stream-heap.timed.test.ts: runs range -> identity -> discard over a discarding store and reports peak heap.
import { parentPort, workerData } from 'node:worker_threads';
import { SeqConflictError } from '@loopwork/eventlog';
import { flow } from '@loopwork/graph';
import { createBuiltins, executeRun } from '../dist/index.js';

const { count } = workerData;
const any = {};
const def = flow('f', 'F')
  .source('src', { fn: 'range', params: { count }, out: any })
  .map('m', { fn: 'identity', in: any, out: any })
  .sink('snk', { fn: 'discard', in: any })
  .edge('src.out', 'm.in')
  .edge('m.out', 'snk.in')
  .build();

let lastSeq = 1;
let appended = 0;
let maxHeapUsedMb = 0;
const store = {
  async append(_runId, events, { expectedSeq }) {
    if (expectedSeq !== lastSeq) throw new SeqConflictError(`expected seq ${expectedSeq}, run is at ${lastSeq}`);
    const before = appended;
    appended += events.length;
    if (Math.floor(appended / 5000) > Math.floor(before / 5000)) maxHeapUsedMb = Math.max(maxHeapUsedMb, process.memoryUsage().heapUsed / 2 ** 20);
    lastSeq += events.length;
    return { lastSeq };
  },
  async *read() {
    yield { type: 'RunCreated', runId: 'r', seq: 1, ts: new Date().toISOString(), flow: def, createdBy: 'cli' };
  },
};

const started = Date.now();
const outcome = await executeRun({
  runId: 'r',
  store,
  registry: createBuiltins(),
  signal: new AbortController().signal,
  workerId: 'w1',
  expectedSeq: 1,
});
parentPort.postMessage({ outcome, appended, maxHeapUsedMb, ms: Date.now() - started });
