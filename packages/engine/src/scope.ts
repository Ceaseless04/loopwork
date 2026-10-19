import type { NewEvent } from '@loopwork/eventlog';
import type { Edge, FlowNode, JsonValue } from '@loopwork/graph';
import { createChannel, type Channel } from './channel.js';
import type { Recorder } from './recorder.js';
import type { Item, NodeKind, NodeRegistry, StepContext } from './registry.js';
import { runPool, type Limiter } from './scheduler.js';

/** Run-wide state shared by every scope: one abort signal, recorder, global limiter and channel set. */
export type ScopeEnv = {
  runId: string;
  input: JsonValue | undefined;
  registry: NodeRegistry;
  signal: AbortSignal;
  rec: Recorder;
  emit(e: NewEvent): void;
  fail(reason: 'step' | 'budget' | 'internal', message: string, node?: string): void;
  limiter: Limiter;
  capacity: number;
  /** Every live channel of every scope; the run's stop() closes them all. */
  channels: Set<Channel<Item>>;
};
export type ScopeOpts = { nodes: Record<string, FlowNode>; edges: Edge[]; prefix: string };
export type Scope = { work: Promise<void>[]; dispose(): void };

export function createRunScope(env: ScopeEnv): (o: ScopeOpts) => Scope {
  const { runId, rec, emit, signal, limiter } = env;
  const fnOf = <K extends NodeKind>(kind: K, name: string) => {
    const fn = env.registry.get(kind, name);
    if (!fn) throw new Error(`${kind} "${name}" is not registered`);
    return fn;
  };
  const makeCtx = (node: string, itemId: string, attempt: number, runInput?: JsonValue): StepContext => {
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
      attempt,
      signal,
      idempotencyKey: `${runId}/${node}/${itemId}`,
      input: runInput,
      now: () => logged(`now#${nows++}`, Date.now()),
      random: () => logged(`random#${randoms++}`, Math.random()),
    };
  };

  return ({ nodes, edges, prefix }) => {
    // Wiring keyed by port (`node.port`): one channel per consumer input port; `targets` = input ports fed by an output port; `refs` = producers still feeding a channel.
    const targets = new Map<string, string[]>();
    const refs = new Map<string, number>();
    const channels = new Map<string, Channel<Item>>();
    for (const e of edges) {
      const from = `${prefix}${e.from.node}.${e.from.port}`;
      const to = `${prefix}${e.to.node}.${e.to.port}`;
      targets.set(from, [...(targets.get(from) ?? []), to]);
      refs.set(to, (refs.get(to) ?? 0) + 1);
    }
    for (const [id, n] of Object.entries(nodes)) {
      if (n.kind === 'source') continue;
      const c = createChannel<Item>(env.capacity);
      channels.set(`${prefix}${id}.in`, c);
      env.channels.add(c);
    }
    for (const [key, c] of channels) if (!refs.has(key)) c.close();
    const release = (producer: string): void => {
      for (const t of targets.get(producer) ?? []) {
        const left = (refs.get(t) ?? 1) - 1;
        refs.set(t, left);
        if (left === 0) channels.get(t)?.close();
      }
    };
    const releaseOutputs = (sid: string): void => {
      release(`${sid}.out`);
      release(`${sid}.error`);
    };
    /** A send into a channel closed by stop() is expected, not an error. */
    const sendTo = async (producer: string, item: Item): Promise<void> => {
      for (const t of targets.get(producer) ?? []) {
        try {
          await channels.get(t)?.send(item, signal);
        } catch (e) {
          if (!signal.aborted) throw e;
          return;
        }
      }
    };

    const work: Promise<void>[] = [];
    for (const [id, n] of Object.entries(nodes)) {
      const sid = `${prefix}${id}`;
      if (n.kind === 'source') {
        work.push(
          (async () => {
            let count = 0;
            try {
              for await (const value of fnOf('source', n.fn)(makeCtx(sid, `${sid}.out`, 1, env.input), n.params)) {
                await rec.ready(); // recorder backpressure: don't run ahead of the store
                if (signal.aborted) return;
                const itemId = `${sid}.out#${count++}`;
                emit({ type: 'ItemEmitted', node: sid, itemId, value }); // write-ahead: log leads delivery
                await sendTo(`${sid}.out`, { itemId, value });
              }
            } catch (err) {
              if (signal.aborted) return;
              env.fail('step', err instanceof Error ? err.message : String(err), sid);
              return;
            }
            emit({ type: 'SourceCompleted', node: sid, count });
          })().then(() => releaseOutputs(sid)),
        );
      } else if (n.kind === 'map' || n.kind === 'sink') {
        const input$ = channels.get(`${sid}.in`);
        if (!input$) continue;
        const runStep = async ({ itemId, value }: Item, attempt: number): Promise<void | (() => Promise<void>)> => {
          const ctx = makeCtx(sid, itemId, attempt);
          emit({ type: 'StepStarted', node: sid, itemId, attempt: ctx.attempt });
          try {
            if (n.kind === 'sink') {
              await fnOf('sink', n.fn)(value, ctx, n.params);
              return async () => {
                await rec.flush(); // D4: nothing is reported done before the sink's side effects are durable
                emit({ type: 'StepSucceeded', node: sid, itemId, outputs: [] });
              };
            }
            const result = await fnOf('map', n.fn)(value, ctx, n.params);
            return async () => {
              const values = Array.isArray(result) ? result : [result];
              const outputs = values.map((v, k) => ({ port: 'out', itemId: `${itemId}>${sid}.out#${k}`, value: v }));
              await rec.ready(); // never holds the permit: continuations run after release
              if (signal.aborted) return;
              emit({ type: 'StepSucceeded', node: sid, itemId, outputs });
              for (const o of outputs) {
                if (signal.aborted) return;
                await sendTo(`${sid}.out`, { itemId: o.itemId, value: o.value });
              }
            };
          } catch (err) {
            // Stop here, not via the pool's rejection, so siblings' signals abort at once; emit drops after stop.
            const error = err instanceof Error ? err : new Error(String(err));
            emit({
              type: 'StepFailed',
              node: sid,
              itemId,
              attempt: ctx.attempt,
              error: { name: error.name, message: error.message, ...(error.stack !== undefined && { stack: error.stack }) },
              willRetry: false,
            });
            env.fail('step', error.message, sid);
          }
        };
        work.push(
          runPool({
            input: input$,
            concurrency: n.concurrency ?? 1,
            limiter,
            signal,
            handle: (item) => runStep(item, 1),
          }).then(() => releaseOutputs(sid)),
        );
      }
    }
    return {
      work,
      dispose: () => {
        for (const c of channels.values()) env.channels.delete(c);
      },
    };
  };
}
