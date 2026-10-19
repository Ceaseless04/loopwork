import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const WORKER = new URL('./stream-heap.worker.mjs', import.meta.url);
const ENGINE_DIST = new URL('../dist/index.js', import.meta.url);

type Report = { outcome: { status: string }; appended: number; maxHeapUsedMb: number; ms: number };

function runInWorker(count: number): Promise<Report> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { count }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.once('message', (r: Report) => resolve(r));
    w.once('error', reject); // ERR_WORKER_OUT_OF_MEMORY lands here
    w.once('exit', (code) => reject(new Error(`worker exited with ${code} before reporting`)));
  });
}

describe('executeRun memory', () => {
  it('EC-2: a 100k-item run against a discarding store completes under 256 MB old space', async () => {
    // the worker imports the built engine; never skip silently when it is missing
    if (!existsSync(ENGINE_DIST)) throw new Error('packages/engine/dist is missing: run `pnpm build` first');

    const r = await runInWorker(100_000);

    expect(r.outcome).toEqual({ status: 'succeeded' });
    expect(r.appended).toBe(5 * 100_000 + 3); // RunStarted + 100k x (ItemEmitted, m start+ok, snk start+ok) + SourceCompleted + RunSucceeded
    expect(r.maxHeapUsedMb).toBeLessThan(128); // O(channels + in-flight): measured ~17 MB, independent of N
  }, 60_000);
});
