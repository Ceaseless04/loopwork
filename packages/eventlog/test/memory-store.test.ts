import type { Flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { runStoreContract } from './store-contract.js';

runStoreContract('MemoryStore', async (opts) => ({ store: new MemoryStore(opts), dispose: async () => {} }));

// Regression (new ~0.2s, old ~3.6s on the dev box; bound is 1s): append once re-scanned every stored event (O(n^2) per run). Best of 3 so a noisy host cannot fail it.
describe('MemoryStore append cost', () => {
  it('20k single-event appends on one run stay linear', async () => {
    const flow = { version: 1, id: 'f', name: 'f', nodes: {}, edges: [] } as Flow;
    const n = 20_000;
    let best = Infinity;
    for (let round = 0; round < 3; round++) {
      const store = new MemoryStore();
      await store.create('r', { type: 'RunCreated', flow, createdBy: 'cli' });
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await store.append('r', [{ type: 'ItemEmitted', node: 'src', itemId: `src.out#${i}`, value: i }], { expectedSeq: i + 1 });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(1000);
  });
});
