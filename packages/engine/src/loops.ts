import type { Frame } from '@loopwork/graph';
import { elapsed, withInstance, type FrameHost, type Instance } from './frames.js';
import type { Item, PredicateFn } from './registry.js';

/** What a while/until instance needs beyond `FrameHost`, namely the run id, its predicate, one body pass and the enclosing retry's state. */
export type LoopOps = {
  runId: string;
  test: PredicateFn;
  /** Runs the body once on `entry` in a fresh scope and returns every item it emitted on its exit. */
  iterate(inst: Instance, entry: Item): Promise<Item[]>;
  /** An enclosing emit-error retry was exhausted: this instance is abandoned rather than failed. */
  abandoned(): boolean;
};

/**
 * Lifecycle of one while/until instance (write-ahead: every event is logged before its effect). The item is the initial
 * state; each iteration's single body output becomes the next state, and the final state leaves on `out`.
 */
export function runLoopInstance(
  h: FrameHost,
  f: { id: string; node: Extract<Frame, { frame: 'while' | 'until' }>; instances: Map<string, Instance> },
  item: Item,
  ops: LoopOps,
): Promise<void> {
  const { node } = f;
  const max = node.budgets.maxIterations;
  return withInstance(h, f, item, 1, 0, async (inst) => {
    let state = item.value;
    // undefined = stop: a throwing predicate fails the run as a step error of the frame (it is not a step: no StepFailed).
    const holds = async (): Promise<boolean | undefined> => {
      try {
        return await ops.test(state, { runId: ops.runId, node: f.id, itemId: inst.itemId, signal: h.signal }, node.conditionParams);
      } catch (e) {
        if (!h.signal.aborted) h.fail('step', e instanceof Error ? e.message : String(e), f.id);
        return undefined;
      }
    };
    let n = 0;
    for (;;) {
      if (node.frame === 'while') {
        const go = await holds();
        if (go === undefined || h.signal.aborted) return;
        if (!go) break;
      }
      if (n >= max) {
        h.emit({ type: 'BudgetExceeded', node: f.id, itemId: inst.itemId, budget: 'iterations', limit: max, used: max });
        return h.fail('budget', `frame "${f.id}" exceeded its iteration budget (maxIterations=${max})`, f.id);
      }
      n++;
      inst.iteration = n;
      h.emit({ type: 'IterationStarted', node: f.id, itemId: inst.itemId, iteration: n });
      const t0 = Date.now();
      const out = await ops.iterate(inst, { itemId: `${inst.itemId}>${f.id}.iter#${n}`, value: state });
      if (h.signal.aborted) return;
      h.emit({ type: 'IterationEnded', node: f.id, itemId: inst.itemId, iteration: n, elapsedMs: elapsed(t0) });
      if (ops.abandoned()) {
        h.emit({ type: 'FrameExited', node: f.id, itemId: inst.itemId, reason: 'retries-exhausted' });
        return;
      }
      const [next] = out;
      if (out.length !== 1 || !next) return h.fail('step', `frame "${f.id}" body emitted ${out.length} items; expected exactly 1`, f.id);
      state = next.value;
      if (node.frame === 'until') {
        const done = await holds();
        if (done === undefined || h.signal.aborted) return;
        if (done) break;
      }
    }
    const final = { itemId: `${inst.itemId}>${f.id}.out#0`, value: state };
    h.emit({ type: 'FrameExited', node: f.id, itemId: inst.itemId, reason: 'condition', outputs: [{ port: 'out', ...final }] });
    clearTimeout(inst.timer); // already exited: a breach while the send is blocked must not log BudgetExceeded
    await h.send('out', final); // write-ahead: FrameExited is logged before the item is delivered
  });
}
