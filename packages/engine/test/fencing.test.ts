import { MemoryStore, type LoopworkEvent, type NewEvent } from '@loopwork/eventlog';
import { describe, expect, it } from 'vitest';
import { createBuiltins, executeRun, type RunOutcome } from '../src/index.js';
import { eventsOf, pipelineFlow, startRun } from './helpers.js';

const ITEMS = 5000;
const TERMINAL = ['RunSucceeded', 'RunFailed', 'RunCancelled'];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
const intruder: NewEvent = { type: 'SideEffect', node: 'other', itemId: 'other.out#0', key: 'k', value: 1 };

/** A store whose run gets a competing append ("another executor") right before the first executor append for which `when` holds. */
class FencedStore extends MemoryStore {
  intruded = false;
  appends = 0;
  constructor(private readonly when: (events: NewEvent[], appends: number) => boolean) {
    super();
  }

  override async append(runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }> {
    if (!this.intruded && this.when(events, this.appends++)) {
      this.intruded = true;
      const row = await this.getRun(runId);
      await super.append(runId, [intruder], { expectedSeq: row?.lastSeq ?? 0 });
    }
    return super.append(runId, events, opts);
  }
}

async function fence(store: FencedStore, count: number) {
  let calls = 0;
  const registry = createBuiltins();
  registry.map('counted', async (item) => {
    calls++;
    return item;
  });
  const { expectedSeq } = await startRun(store, 'r', pipelineFlow({ count, mapFn: 'counted' }));
  const outcome: RunOutcome = await executeRun({
    runId: 'r',
    store,
    registry,
    signal: new AbortController().signal,
    workerId: 'w1',
    expectedSeq,
    flush: { maxEvents: 1, maxMs: 1 },
  });
  return { outcome, events: await eventsOf(store, 'r'), calls: () => calls };
}

const terminals = (events: LoopworkEvent[]) => events.filter((e) => TERMINAL.includes(e.type));

describe('executeRun fencing', () => {
  it('EC-14: a second executor appending mid-run fences the first, which returns fenced and stops issuing steps', async () => {
    const store = new FencedStore((_events, appends) => appends === 20);
    const { outcome, events, calls } = await fence(store, ITEMS);

    expect(store.intruded).toBe(true);
    expect(outcome).toEqual({ status: 'fenced' });
    // the competitor's event is the log tail: the fenced executor appended nothing after the conflict, and no terminal event
    expect(events.at(-1)).toEqual(expect.objectContaining(intruder));
    expect(terminals(events)).toEqual([]);
    // no more steps are issued after the outcome
    const settled = calls();
    for (let i = 0; i < 5; i++) await tick();
    expect(calls()).toBe(settled);
    expect(settled).toBeLessThan(ITEMS / 5);
    expect((await eventsOf(store, 'r')).length).toBe(events.length);
  });

  it('EC-14: a competitor appending before RunStarted fences the executor before it logs anything', async () => {
    const store = new FencedStore(() => true);
    const { outcome, events, calls } = await fence(store, 10);

    expect(outcome).toEqual({ status: 'fenced' });
    expect(events.map((e) => e.type)).toEqual(['RunCreated', 'SideEffect']);
    expect(calls()).toBe(0);
  });

  it('EC-14: a competitor appending just before the terminal flush fences the executor, which logs no terminal event', async () => {
    const store = new FencedStore((events) => events.some((e) => TERMINAL.includes(e.type)));
    const { outcome, events } = await fence(store, 3);

    expect(store.intruded).toBe(true);
    expect(outcome).toEqual({ status: 'fenced' });
    expect(events.at(-1)).toEqual(expect.objectContaining(intruder));
    expect(terminals(events)).toEqual([]);
  });
});
