import { applyEvent, emptyRunState } from '@loopwork/eventlog';
import type { EventStore, NewEvent } from '@loopwork/eventlog';
import type { JsonValue } from '@loopwork/graph';
import type { Channel } from './channel.js';
import { unrunnable } from './guards.js';
import { createRecorder } from './recorder.js';
import type { Item, NodeRegistry } from './registry.js';
import { createLimiter, type Limiter } from './scheduler.js';
import { createRunScope } from './scope.js';

export type ExecuteOptions = {
  runId: string;
  store: EventStore;
  registry: NodeRegistry;
  signal: AbortSignal;
  workerId: string;
  expectedSeq: number;
  // ponytail: unused until slice 6 (D9). Ceiling: a step that ignores its signal blocks the return; upgrade: race the pool with a cancelGraceMs timer.
  cancelGraceMs?: number;
  channelCapacity?: number;
  maxInFlight?: number;
  flush?: { maxEvents: number; maxMs: number };
};

export type RunOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; reason: 'step' | 'budget' | 'internal'; message: string; node?: string }
  | { status: 'cancelled' }
  | { status: 'fenced' };

function terminalEvent(o: RunOutcome): NewEvent | undefined {
  switch (o.status) {
    case 'succeeded':
      return { type: 'RunSucceeded' };
    case 'cancelled':
      return { type: 'RunCancelled' };
    case 'failed':
      return { type: 'RunFailed', reason: o.reason, message: o.message, ...(o.node !== undefined && { node: o.node }) };
    case 'fenced':
      return undefined;
  }
}

export async function executeRun(opts: ExecuteOptions): Promise<RunOutcome> {
  const { runId, store, registry } = opts;
  let state = emptyRunState();
  let input: JsonValue | undefined;
  for await (const e of store.read(runId)) {
    if (e.type === 'RunCreated') input = e.input;
    state = applyEvent(state, e);
  }
  if (state.status === 'succeeded' || state.status === 'cancelled') return { status: state.status };

  const ctrl = new AbortController();
  const channels = new Set<Channel<Item>>();
  let decided: RunOutcome | undefined;
  /** First outcome wins; aborts workers and closes every channel so blocked ones wake. */
  const stop = (outcome: RunOutcome): void => {
    if (decided) return;
    decided = outcome;
    ctrl.abort();
    for (const c of channels) c.close(); // belt-and-braces: blocked sends/recvs are also woken by the abort signal
  };
  const rec = createRecorder({
    store,
    runId,
    expectedSeq: opts.expectedSeq,
    maxEvents: opts.flush?.maxEvents ?? 500,
    maxMs: opts.flush?.maxMs ?? 50,
    onFenced: () => stop({ status: 'fenced' }),
    onError: (e) => stop({ status: 'failed', reason: 'internal', message: e instanceof Error ? e.message : String(e) }), // executeRun still rejects with it
  });
  /** Step-level events are dropped once the outcome is decided (a pending continuation must not log after stop). */
  const emit = (e: NewEvent): void => {
    if (!ctrl.signal.aborted) rec.push(e);
  };
  const finish = async (outcome: RunOutcome): Promise<RunOutcome> => {
    const terminal = terminalEvent(outcome);
    if (terminal && !rec.fenced) {
      rec.push(terminal);
      await rec.close();
    }
    return rec.fenced ? { status: 'fenced' } : outcome;
  };

  rec.push({ type: 'RunStarted', workerId: opts.workerId, attempt: state.attempt + 1 });
  await rec.flush();
  if (rec.fenced) return { status: 'fenced' };
  const flow = state.flow;
  const problem = unrunnable(flow, state, registry);
  if (problem !== undefined || !flow) return finish({ status: 'failed', reason: 'internal', message: problem ?? 'run has no flow' });

  const { work } = createRunScope({
    runId,
    input,
    registry,
    signal: ctrl.signal,
    rec,
    emit,
    fail: (reason, message, node) => stop({ status: 'failed', reason, message, ...(node !== undefined && { node }) }),
    limiter: createLimiter(opts.maxInFlight ?? 64),
    capacity: opts.channelCapacity ?? 64,
    channels,
    nodeLimiters: new Map<string, Limiter>(),
  })({ nodes: flow.nodes, edges: flow.edges, prefix: '' });

  const onAbort = (): void => stop({ status: 'cancelled' });
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all(
      work.map((p) =>
        p.catch((e: unknown) =>
          stop({ status: 'failed', reason: 'internal', message: e instanceof Error ? e.message : String(e) }),
        ),
      ),
    );
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
  return finish(decided ?? { status: 'succeeded' });
}
