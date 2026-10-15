import { MemoryStore } from '../src/memory-store.js';
import { runStoreContract } from './store-contract.js';

runStoreContract('MemoryStore', async (opts) => ({ store: new MemoryStore(opts), dispose: async () => {} }));
