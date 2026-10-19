import { applyEvent, emptyRunState } from '@loopwork/eventlog';
import type { EventStore, NewEvent, RunState } from '@loopwork/eventlog';
import type { Flow, JsonValue } from '@loopwork/graph';
import { createChannel, type Channel } from './channel.js';
import { createRecorder } from './recorder.js';
import type { NodeKind, NodeRegistry, StepContext } from './registry.js';
import { createLimiter, runPool } from './scheduler.js';

export type ExecuteOptions = {
  runId: string;
  store: EventStore;
  registry: NodeRegistry;
  signal: AbortSignal;
  workerId: string;
  expectedSeq: number;
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

type Item = { itemId: string; value: JsonValue };

/** Why this log/flow cannot run in this slice (plain flows, fresh logs only), or undefined. */
function unrunnable(flow: Flow | undefined, state: RunState, registry: NodeRegistry): string | undefined {
  if (!flow) return 'run has no flow';
  for (const [id, n] of Object.entries(flow.nodes)) {
    if (n.kind === 'frame') return `node "${id}" is a frame; frames land in engine-core slices 3-4`;
    if (!registry.has(n.kind, n.fn)) return `node "${id}": unknown ${n.kind} fn "${n.fn}"`;
  }
  const edgeWork = [...state.edges.values()].some((c) => c.emitted > 0);
  const inFlight = [...state.nodes.values()].some((n) => n.inFlight.size > 0);
  if (state.committed.size > 0 || state.sourcesCompleted.size > 0 || edgeWork || inFlight) {
    return 'log already holds work; resume lands in engine-core slice 5';
  }
  return undefined;
}

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
  const channels = new Map<string, Channel<Item>>();
  let decided: RunOutcome | undefined;
  /** First outcome wins; aborts workers and closes every channel so blocked ones wake. */
  const stop = (outcome: RunOutcome): void => {
    if (decided) return;
    decided = outcome;
    ctrl.abort();
    for (const c of channels.values()) c.close();
  };
  const rec = createRecorder({
    store,
    runId,
    expectedSeq: opts.expectedSeq,
    maxEvents: opts.flush?.maxEvents ?? 500,
    maxMs: opts.flush?.maxMs ?? 50,
    onFenced: () => stop({ status: 'fenced' }),
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

  // Wiring: one channel per consumer node; `targets` = consumers fed by a producer; `refs` = producers still feeding a channel.
  const capacity = opts.channelCapacity ?? 64;
  const targets = new Map<string, string[]>();
  const refs = new Map<string, number>();
  for (const e of flow.edges) {
    targets.set(e.from.node, [...(targets.get(e.from.node) ?? []), e.to.node]);
    refs.set(e.to.node, (refs.get(e.to.node) ?? 0) + 1);
  }
  for (const [id, n] of Object.entries(flow.nodes)) if (n.kind !== 'source') channels.set(id, createChannel<Item>(capacity));
  for (const [id, c] of channels) if (!refs.has(id)) c.close();
  const release = (producer: string): void => {
    for (const t of targets.get(producer) ?? []) {
      const left = (refs.get(t) ?? 1) - 1;
      refs.set(t, left);
      if (left === 0) channels.get(t)?.close();
    }
  };
  /** A send into a channel closed by stop() is expected, not an error. */
  const sendTo = async (producer: string, item: Item): Promise<void> => {
    for (const t of targets.get(producer) ?? []) {
      try {
        await channels.get(t)?.send(item, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) throw e;
        return;
      }
    }
  };

  const fnOf = <K extends NodeKind>(kind: K, name: string) => {
    const fn = registry.get(kind, name);
    if (!fn) throw new Error(`${kind} "${name}" is not registered`);
    return fn;
  };
  const makeCtx = (node: string, itemId: string, runInput?: JsonValue): StepContext => {
    let nows = 0;
    let randoms = 0;
    const logged = (key: string, value: number): number => {
      emit({ type: 'SideEffect', node, itemId, key, value });
      return value;
    };
    return {
      runId,
      node,
      itemId,
      attempt: 1,
      signal: ctrl.signal,
      idempotencyKey: `${runId}/${node}/${itemId}`,
      input: runInput,
      now: () => logged(`now#${nows++}`, Date.now()),
      random: () => logged(`random#${randoms++}`, Math.random()),
    };
  };

  const limiter = createLimiter(opts.maxInFlight ?? 64);
  const work: Promise<void>[] = [];
  for (const [id, n] of Object.entries(flow.nodes)) {
    if (n.kind === 'source') {
      work.push(
        (async () => {
          let count = 0;
          for await (const value of fnOf('source', n.fn)(makeCtx(id, `${id}.out`, input), n.params)) {
            if (ctrl.signal.aborted) return;
            const itemId = `${id}.out#${count++}`;
            await sendTo(id, { itemId, value });
            emit({ type: 'ItemEmitted', node: id, itemId, value });
          }
          emit({ type: 'SourceCompleted', node: id, count });
        })().then(() => release(id)),
      );
    } else if (n.kind === 'map' || n.kind === 'sink') {
      const input$ = channels.get(id);
      if (!input$) continue;
      work.push(
        runPool({
          input: input$,
          concurrency: n.concurrency ?? 1,
          limiter,
          signal: ctrl.signal,
          handle: async ({ itemId, value }) => {
            emit({ type: 'StepStarted', node: id, itemId, attempt: 1 });
            if (n.kind === 'sink') {
              await fnOf('sink', n.fn)(value, makeCtx(id, itemId), n.params);
              return async () => {
                await rec.flush(); // D4: nothing is reported done before the sink's side effects are durable
                emit({ type: 'StepSucceeded', node: id, itemId, outputs: [] });
              };
            }
            const result = await fnOf('map', n.fn)(value, makeCtx(id, itemId), n.params);
            return async () => {
              const values = Array.isArray(result) ? result : [result];
              const outputs = values.map((v, k) => ({ port: 'out', itemId: `${itemId}>${id}.out#${k}`, value: v }));
              emit({ type: 'StepSucceeded', node: id, itemId, outputs });
              for (const o of outputs) {
                if (ctrl.signal.aborted) return;
                await sendTo(id, { itemId: o.itemId, value: o.value });
              }
            };
          },
        }).then(() => release(id)),
      );
    }
  }

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
