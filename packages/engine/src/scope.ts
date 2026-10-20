import type { NewEvent } from '@loopwork/eventlog';
import type { Edge, FlowNode, JsonValue } from '@loopwork/graph';
import { createChannel, type Channel } from './channel.js';
import type { Recorder } from './recorder.js';
import type { Item, NodeKind, NodeRegistry, StepContext } from './registry.js';
import { backoffMs, runInstance, sleep, type Instance, type RetryScope } from './frames.js';
import { chain, createLimiter, runHeld, runPool, type Limiter } from './scheduler.js';

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
  /** Per-node concurrency limiters of frame bodies, keyed by scoped id and shared by every instance of the frame. */
  nodeLimiters: Map<string, Limiter>;
};
/** A frame body scope also gets `entry` (scoped input port fed by `enter`) and `exit` (scoped output port forwarded out of the frame). */
export type ScopeOpts = {
  nodes: Record<string, FlowNode>;
  edges: Edge[];
  prefix: string;
  entry?: string;
  exit?: { port: string; send(item: Item): Promise<void> };
  /** Concurrency inherited by body nodes that set none: the nearest enclosing foreach's. Absent outside frame bodies. */
  defaultConcurrency?: number;
  /** Policy of the nearest enclosing retry frame: a failing body step retries under it. */
  retry?: RetryScope;
};
export type Scope = { work: Promise<void>[]; enter(port: string, item: Item): Promise<void>; dispose(): void };

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

  const nodeLimiterOf = (sid: string, concurrency: number): Limiter => {
    let l = env.nodeLimiters.get(sid);
    if (!l) env.nodeLimiters.set(sid, (l = createLimiter(concurrency)));
    return l;
  };

  const runScope = ({ nodes, edges, prefix, entry, exit, defaultConcurrency, retry }: ScopeOpts): Scope => {
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
    if (entry !== undefined) refs.set(entry, (refs.get(entry) ?? 0) + 1); // the frame boundary feeds the entry until enter() returns
    for (const [id, n] of Object.entries(nodes)) {
      if (n.kind === 'source') continue;
      const c = createChannel<Item>(env.capacity);
      channels.set(`${prefix}${id}.in`, c);
      env.channels.add(c);
    }
    for (const [key, c] of channels) if (!refs.has(key)) c.close();
    const unref = (t: string): void => {
      const left = (refs.get(t) ?? 1) - 1;
      refs.set(t, left);
      if (left === 0) channels.get(t)?.close();
    };
    const release = (producer: string): void => targets.get(producer)?.forEach(unref);
    const releaseOutputs = (sid: string): void => {
      release(`${sid}.out`);
      release(`${sid}.error`);
    };
    /** A send into a channel closed by stop() is expected, not an error. */
    const tolerant = async (send: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await send();
      } catch (e) {
        if (!signal.aborted) throw e;
      }
    };
    const sendTo = (producer: string, item: Item): Promise<void> =>
      tolerant(async () => {
        for (const t of targets.get(producer) ?? []) await channels.get(t)?.send(item, signal);
        if (producer === exit?.port) await exit.send(item);
      });
    const enter = async (port: string, item: Item): Promise<void> => {
      await tolerant(() => channels.get(port)?.send(item, signal));
      unref(port);
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
        continue;
      }
      const input$ = channels.get(`${sid}.in`);
      if (!input$) continue;
      if (n.kind === 'map' || n.kind === 'sink') {
        const stepLimiter = prefix === '' ? limiter : chain(nodeLimiterOf(sid, n.concurrency ?? defaultConcurrency ?? 1), limiter);
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
            const willRetry = retry !== undefined && attempt < retry.maxAttempts;
            emit({
              type: 'StepFailed',
              node: sid,
              itemId,
              attempt: ctx.attempt,
              error: { name: error.name, message: error.message, ...(error.stack !== undefined && { stack: error.stack }) },
              willRetry,
            });
            if (!willRetry) {
              if (retry?.exhaust) return retry.exhaust(error.message); // emit-error: siblings keep draining, the instance exits retries-exhausted
              return env.fail('step', error.message, sid);
            }
            return async () => {
              try {
                await sleep(backoffMs(retry.backoff, attempt), signal); // holds no permit: continuations run after release
              } catch (e) {
                if (signal.aborted) return;
                throw e;
              }
              const next = await runHeld(stepLimiter, (it) => runStep(it, attempt + 1), { itemId, value }, signal);
              if (next) await next();
            };
          }
        };
        work.push(
          runPool({
            input: input$,
            concurrency: n.concurrency ?? 1,
            limiter: stepLimiter,
            signal,
            handle: (item) => runStep(item, 1),
          }).then(() => releaseOutputs(sid)),
        );
      } else if (n.frame === 'foreach' || n.frame === 'retry') {
        const concurrency = n.frame === 'foreach' ? n.concurrency : 1; // retry instances run one at a time
        const instances = new Map<string, Instance>();
        const entryPort = `${sid}.${n.body.entry.node}.${n.body.entry.port}`;
        const runBody = async (inst: Instance): Promise<void> => {
          if (signal.aborted) return;
          const bodyRetry: RetryScope | undefined =
            n.frame === 'retry'
              ? {
                  maxAttempts: n.maxAttempts,
                  backoff: n.backoff,
                  ...(n.onExhausted === 'emit-error' && { exhaust: (message: string) => void (inst.exhausted ??= { message }) }),
                }
              : retry;
          const sub = runScope({
            nodes: n.body.nodes,
            edges: n.body.edges,
            prefix: `${sid}.`,
            entry: entryPort,
            defaultConcurrency: concurrency,
            ...(bodyRetry && { retry: bodyRetry }),
            exit: { port: `${sid}.${n.body.exit.node}.${n.body.exit.port}`, send: (it) => sendTo(`${sid}.out`, it) },
          });
          try {
            await sub.enter(entryPort, { itemId: inst.itemId, value: inst.value });
            await Promise.all(sub.work);
          } finally {
            sub.dispose();
          }
        };
        work.push(
          runPool({
            input: input$,
            concurrency,
            limiter: nodeLimiterOf(sid, concurrency), // the instance holds only the frame's permit, never a global one
            signal,
            handle: (item) => runInstance({ rec, emit, signal, send: (port, it) => sendTo(`${sid}.${port}`, it) }, { id: sid, node: n, instances }, item, runBody),
          }).then(() => releaseOutputs(sid)),
        );
      }
    }
    return {
      work,
      enter,
      dispose: () => {
        for (const c of channels.values()) env.channels.delete(c);
      },
    };
  };
  return runScope;
}
