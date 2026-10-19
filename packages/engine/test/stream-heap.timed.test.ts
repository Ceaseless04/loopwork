import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.resolve(PKG_DIR, 'dist/index.js');

// Black-box child: loads the built package by a runtime-built URL (no static import of dist anywhere), runs
// range -> identity -> discard over a discarding store and prints one JSON line. cwd = the engine package, so the
// bare @loopwork/* imports resolve through its node_modules workspace links.
const CHILD = `
import { pathToFileURL } from 'node:url';
import { SeqConflictError } from '@loopwork/eventlog';
import { flow } from '@loopwork/graph';
const { createBuiltins, executeRun } = await import(pathToFileURL(process.argv[1]).href);
const count = Number(process.argv[2]);
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
    if (expectedSeq !== lastSeq) throw new SeqConflictError('expected seq ' + expectedSeq + ', run is at ' + lastSeq);
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
const outcome = await executeRun({ runId: 'r', store, registry: createBuiltins(), signal: new AbortController().signal, workerId: 'w1', expectedSeq: 1 });
process.stdout.write(JSON.stringify({ outcome, appended, maxHeapUsedMb }) + '\\n');
`;

type Report = { outcome: { status: string }; appended: number; maxHeapUsedMb: number };

function runChild(count: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--max-old-space-size=256', '--input-type=module', '--eval', CHILD, DIST, String(count)],
      { cwd: PKG_DIR, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null; // null: killed by a signal / spawn failure
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('executeRun memory', () => {
  it('EC-2: a 100k-item run against a discarding store completes under 256 MB old space', async () => {
    // the child imports the built engine; never skip silently when it is missing
    if (!existsSync(DIST)) throw new Error('packages/engine/dist is missing: run `pnpm build` first');

    const { code, stdout, stderr } = await runChild(100_000);
    expect(code, `child exited with ${String(code)}; stderr:\n${stderr}`).toBe(0);

    const r = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Report;
    expect(r.outcome).toEqual({ status: 'succeeded' });
    expect(r.appended).toBe(5 * 100_000 + 3); // RunStarted + 100k x (ItemEmitted, m start+ok, snk start+ok) + SourceCompleted + RunSucceeded
    expect(r.maxHeapUsedMb).toBeLessThan(128); // O(channels + in-flight): measured ~17 MB, independent of N
  }, 60_000);
});
