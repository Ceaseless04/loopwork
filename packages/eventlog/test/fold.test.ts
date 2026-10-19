import type { Flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import type { LoopworkEvent, NewEvent } from '../src/events.js';
import { applyEvent, emptyRunState, foldRun, sideEffectKey, statusOf } from '../src/fold.js';
import type { RunState } from '../src/fold.js';

// Flow used by the main log: src -> m -> loop(foreach: b1 -> b2) -> snk.
// Flattened scoped edge ids (format `${from.node}.${from.port}->${to.node}.${to.port}`, SPEC-graph-model.md):
const E_SRC_M = 'src.out->m.in';
const E_M_LOOP = 'm.out->loop.in';
const E_LOOP_SNK = 'loop.out->snk.in';
const E_B1_B2 = 'loop.b1.out->loop.b2.in';

const flow: Flow = {
  version: 1,
  id: 'f1',
  name: 'fold-test',
  nodes: {
    src: { kind: 'source', fn: 'range', out: {} },
    m: { kind: 'map', fn: 'identity', in: {}, out: {} },
    loop: {
      kind: 'frame',
      frame: 'foreach',
      budgets: { maxIterations: 10, maxDurationMs: 1000 },
      concurrency: 2,
      in: {},
      out: {},
      body: {
        nodes: {
          b1: { kind: 'map', fn: 'identity', in: {}, out: {} },
          b2: { kind: 'map', fn: 'identity', in: {}, out: {} },
        },
        edges: [{ from: { node: 'b1', port: 'out' }, to: { node: 'b2', port: 'in' } }],
        entry: { node: 'b1', port: 'in' },
        exit: { node: 'b2', port: 'out' },
      },
    },
    snk: { kind: 'sink', fn: 'discard', in: {} },
  },
  edges: [
    { from: { node: 'src', port: 'out' }, to: { node: 'm', port: 'in' } },
    { from: { node: 'm', port: 'out' }, to: { node: 'loop', port: 'in' } },
    { from: { node: 'loop', port: 'out' }, to: { node: 'snk', port: 'in' } },
  ],
};

const whileFlow: Flow = {
  version: 1,
  id: 'w',
  name: 'w',
  nodes: {
    src: { kind: 'source', fn: 'range', out: {} },
    W: {
      kind: 'frame',
      frame: 'while',
      budgets: { maxIterations: 10, maxDurationMs: 1000 },
      condition: 'lessThan',
      in: {},
      out: {},
      body: {
        nodes: { x: { kind: 'map', fn: 'increment', in: {}, out: {} } },
        edges: [],
        entry: { node: 'x', port: 'in' },
        exit: { node: 'x', port: 'out' },
      },
    },
    snk: { kind: 'sink', fn: 'discard', in: {} },
  },
  edges: [
    { from: { node: 'src', port: 'out' }, to: { node: 'W', port: 'in' } },
    { from: { node: 'W', port: 'out' }, to: { node: 'snk', port: 'in' } },
  ],
};

const toLog = (news: NewEvent[]): LoopworkEvent[] =>
  news.map((e, i) => ({ ...e, runId: 'r1', seq: i + 1, ts: '2026-01-01T00:00:00.000Z' }));

const created = (f: Flow = flow): NewEvent => ({ type: 'RunCreated', flow: f, createdBy: 'cli' });
const runStarted = (attempt: number): NewEvent => ({ type: 'RunStarted', workerId: `w${attempt}`, attempt });
const stepStarted = (node: string, itemId: string, attempt = 1): NewEvent => ({ type: 'StepStarted', node, itemId, attempt });
const stepOk = (node: string, itemId: string, outputs: { port: string; itemId: string }[] = []): NewEvent => ({
  type: 'StepSucceeded',
  node,
  itemId,
  outputs: outputs.map((o) => ({ ...o, value: 1 })),
});
const stepFailed = (node: string, itemId: string, attempt: number, message = 'boom', willRetry = false): NewEvent => ({
  type: 'StepFailed',
  node,
  itemId,
  attempt,
  error: { name: 'Error', message },
  willRetry,
});

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};
const nodeOf = (s: RunState, id: string) => must(s.nodes.get(id), `node ${id}`);
const edgeOf = (s: RunState, id: string) => must(s.edges.get(id), `edge ${id}`);
const frameOf = (s: RunState, id: string) => must(s.frames.get(id), `frame ${id}`);

// Hand-built realistic log. `marks` records prefix lengths so tests can fold up to a named point.
const A = 'src.out#0>m.out#0'; // foreach instance item for source item 0
const B = 'src.out#1>m.out#0';
const A1 = `${A}>loop.b1.out#0`;
const B1 = `${B}>loop.b1.out#0`;
const A2 = `${A1}>loop.b2.out#0`;
const B2 = `${B1}>loop.b2.out#0`;

const news: NewEvent[] = [];
const marks: Record<string, number> = {};
const add = (...es: NewEvent[]): void => {
  news.push(...es);
};
const mark = (name: string): void => {
  marks[name] = news.length;
};

add(created(), runStarted(1));
add(
  { type: 'ItemEmitted', node: 'src', itemId: 'src.out#0', value: 0 },
  { type: 'ItemEmitted', node: 'src', itemId: 'src.out#1', value: 1 },
);
mark('emitted');
add(stepStarted('m', 'src.out#0'), stepStarted('m', 'src.out#1'));
mark('mInFlight');
add(stepOk('m', 'src.out#0', [{ port: 'out', itemId: A }]));
mark('m0Done');
add({ type: 'SideEffect', node: 'm', itemId: 'src.out#1', key: 'now', value: 123 });
// worker 1 crashed with m/src.out#1 in flight; worker 2 takes over
add(runStarted(2));
mark('resumed');
add(stepStarted('m', 'src.out#1', 2));
mark('mRerun');
add(stepFailed('m', 'src.out#1', 2, 'flaky', true));
mark('mFailed');
add(stepStarted('m', 'src.out#1', 3), stepOk('m', 'src.out#1', [{ port: 'out', itemId: B }]));
mark('mDone');
add({ type: 'SourceCompleted', node: 'src', count: 2 });
add({ type: 'FrameEntered', node: 'loop', itemId: A, frame: 'foreach' });
add({ type: 'FrameEntered', node: 'loop', itemId: B, frame: 'foreach' });
mark('entered');
add({ type: 'IterationStarted', node: 'loop', itemId: A, iteration: 1 }, stepStarted('loop.b1', A));
mark('bodyAStarted');
add(
  stepOk('loop.b1', A, [{ port: 'out', itemId: A1 }]),
  stepStarted('loop.b2', A1),
  stepOk('loop.b2', A1, [{ port: 'out', itemId: A2 }]),
  { type: 'IterationEnded', node: 'loop', itemId: A, iteration: 1, elapsedMs: 40 },
  { type: 'FrameExited', node: 'loop', itemId: A, reason: 'input-done' },
);
mark('exitedA');
add(
  { type: 'IterationStarted', node: 'loop', itemId: B, iteration: 1 },
  stepStarted('loop.b1', B),
  stepOk('loop.b1', B, [{ port: 'out', itemId: B1 }]),
  stepStarted('loop.b2', B1),
  stepOk('loop.b2', B1, [{ port: 'out', itemId: B2 }]),
  { type: 'IterationEnded', node: 'loop', itemId: B, iteration: 1, elapsedMs: 25 },
  { type: 'FrameExited', node: 'loop', itemId: B, reason: 'input-done' },
);
mark('exitedB');
add(stepStarted('snk', A2), stepStarted('snk', B2));
mark('sinkStarted');
add(stepOk('snk', A2), stepOk('snk', B2), { type: 'RunSucceeded' });

const log = toLog(news);
const upTo = (name: string): RunState => foldRun(log.slice(0, must(marks[name], `mark ${name}`)));

describe('foldRun', () => {
  it('EL-7: foldRun is deterministic (same events, same state)', () => {
    expect(foldRun(log)).toEqual(foldRun(log));
    expect(foldRun(log)).not.toEqual(foldRun(log.slice(0, -1)));
  });

  it('EL-7: foldRun(a ++ b) equals applying b with applyEvent to foldRun(a)', () => {
    const whole = foldRun(log);
    for (let split = 0; split <= log.length; split++) {
      let state = foldRun(log.slice(0, split));
      for (const e of log.slice(split)) state = applyEvent(state, e);
      expect(state, `split at ${split}`).toEqual(whole);
    }
  });

  it('EL-7: applyEvent mutates and returns the state it owns; emptyRunState states share nothing', () => {
    const a = emptyRunState();
    const b = emptyRunState();
    expect(a).toEqual({
      status: 'queued',
      lastSeq: 0,
      attempt: 0,
      nodes: new Map(),
      edges: new Map(),
      frames: new Map(),
      sourcesCompleted: new Set(),
      committed: new Set(),
      recentErrors: [],
      sideEffects: new Map(),
    });
    expect(applyEvent(a, must(log[0], 'first event'))).toBe(a);
    for (const e of log) applyEvent(a, e);
    expect(b).toEqual(emptyRunState());
    expect(b.nodes).not.toBe(a.nodes);
    expect(b.committed).not.toBe(a.committed);
    expect(foldRun([])).toEqual(emptyRunState());
  });

  it('EL-7: lastSeq, status, flow and statusOf follow the log', () => {
    expect(upTo('emitted').flow).toEqual(flow);
    expect(statusOf(foldRun(log.slice(0, 1)))).toBe('queued');
    expect(statusOf(foldRun(log.slice(0, 2)))).toBe('running');
    const done = foldRun(log);
    expect(done.lastSeq).toBe(log.length);
    expect(statusOf(done)).toBe('succeeded');
    expect(done.status).toBe('succeeded');
  });

  it('EL-7: attempt is the highest RunStarted.attempt seen, even if a lower one comes later', () => {
    expect(foldRun(log.slice(0, 2)).attempt).toBe(1);
    expect(upTo('resumed').attempt).toBe(2);
    const odd = toLog([created(), runStarted(1), runStarted(3), runStarted(2)]);
    expect(foldRun(odd).attempt).toBe(3);
  });

  it('EL-7: RunFailed sets failure and status failed', () => {
    const failedLog = toLog([
      created(),
      runStarted(1),
      { type: 'RunFailed', reason: 'step', message: 'boom', node: 'm' },
    ]);
    const s = foldRun(failedLog);
    expect(s.status).toBe('failed');
    expect(s.failure).toMatchObject({ reason: 'step', message: 'boom', node: 'm' });
    expect(foldRun(failedLog.slice(0, 2)).failure).toBeUndefined();
  });

  it('EL-7: RunStarted after RunFailed clears failure and status is running', () => {
    const failed1: NewEvent = { type: 'RunFailed', reason: 'step', message: 'boom', node: 'm' };
    const failed2: NewEvent = { type: 'RunFailed', reason: 'budget', message: 'over' };
    const resumed = foldRun(toLog([created(), runStarted(1), failed1, runStarted(2)]));
    expect(resumed.failure).toBeUndefined();
    expect(resumed.status).toBe('running');
    expect(resumed.attempt).toBe(2);
    const again = foldRun(toLog([created(), runStarted(1), failed1, runStarted(2), failed2]));
    expect(again.status).toBe('failed');
    expect(again.failure).toMatchObject({ reason: 'budget', message: 'over' });
  });

  it('EL-7: per-node started/succeeded/failed counters and inFlight add/remove', () => {
    expect(nodeOf(upTo('mInFlight'), 'm')).toEqual({
      started: 2,
      succeeded: 0,
      failed: 0,
      inFlight: new Map([
        ['src.out#0', 1],
        ['src.out#1', 1],
      ]),
    });
    expect(nodeOf(upTo('m0Done'), 'm')).toEqual({
      started: 2,
      succeeded: 1,
      failed: 0,
      inFlight: new Map([['src.out#1', 1]]),
    });
    // a resumed re-run (attempt 2) counts as another start; inFlight maps itemId -> attempt of the latest StepStarted
    expect(nodeOf(upTo('mRerun'), 'm')).toEqual({
      started: 3,
      succeeded: 1,
      failed: 0,
      inFlight: new Map([['src.out#1', 2]]),
    });
    // StepFailed{willRetry:true} keeps the item in inFlight with its last started attempt
    expect(nodeOf(upTo('mFailed'), 'm')).toEqual({
      started: 3,
      succeeded: 1,
      failed: 1,
      inFlight: new Map([['src.out#1', 2]]),
    });
    expect(nodeOf(upTo('mDone'), 'm')).toEqual({ started: 4, succeeded: 2, failed: 1, inFlight: new Map() });
    // body nodes use their scoped ids
    expect(nodeOf(upTo('bodyAStarted'), 'loop.b1').inFlight).toEqual(new Map([[A, 1]]));
    expect(nodeOf(foldRun(log), 'loop.b2')).toEqual({ started: 2, succeeded: 2, failed: 0, inFlight: new Map() });
    expect(nodeOf(upTo('sinkStarted'), 'snk').inFlight).toEqual(
      new Map([
        [A2, 1],
        [B2, 1],
      ]),
    );
    expect(nodeOf(foldRun(log), 'snk')).toEqual({ started: 2, succeeded: 2, failed: 0, inFlight: new Map() });
  });

  it('EL-7: inFlight keeps an item across StepFailed{willRetry:true}, the retry updates its attempt, and a terminal failure removes it', () => {
    const head = [created(), runStarted(1), stepStarted('m', 'src.out#0')];
    const inFlight = (...es: NewEvent[]) => nodeOf(foldRun(toLog([...head, ...es])), 'm').inFlight;
    expect(inFlight(stepFailed('m', 'src.out#0', 1, 'flaky', true))).toEqual(new Map([['src.out#0', 1]]));
    expect(inFlight(stepFailed('m', 'src.out#0', 1, 'flaky', true), stepStarted('m', 'src.out#0', 3))).toEqual(
      new Map([['src.out#0', 3]]), // attempt 2 never logged (crash-interrupted): stored value is the event's attempt, not a start count
    );
    expect(
      inFlight(stepFailed('m', 'src.out#0', 1, 'flaky', true), stepStarted('m', 'src.out#0', 2), stepOk('m', 'src.out#0')),
    ).toEqual(new Map());
    expect(inFlight(stepFailed('m', 'src.out#0', 1, 'fatal', false))).toEqual(new Map());
  });

  it('EL-7: a retry StepStarted (attempt 2) updates inFlight but does not increment the edge consumed counter', () => {
    const s = foldRun(
      toLog([
        created(),
        runStarted(1),
        { type: 'ItemEmitted', node: 'src', itemId: 'src.out#0', value: 0 },
        stepStarted('m', 'src.out#0'),
        stepFailed('m', 'src.out#0', 1, 'flaky', true),
        stepStarted('m', 'src.out#0', 2),
      ]),
    );
    expect(nodeOf(s, 'm').inFlight).toEqual(new Map([['src.out#0', 2]]));
    expect(edgeOf(s, E_SRC_M)).toEqual({ emitted: 1, consumed: 1 });
  });

  it('EL-7: per-edge emitted/consumed over the flattened scoped edges (itemId-producer derivation)', () => {
    // all edges of the flow exist from RunCreated, body edges with scoped node ids
    expect([...foldRun(log.slice(0, 1)).edges.keys()].sort()).toEqual([E_B1_B2, E_LOOP_SNK, E_M_LOOP, E_SRC_M].sort());
    expect(edgeOf(foldRun(log.slice(0, 1)), E_SRC_M)).toEqual({ emitted: 0, consumed: 0 });

    let s = upTo('emitted'); // ItemEmitted on source `src` feeds edges from `src.out`
    expect(edgeOf(s, E_SRC_M)).toEqual({ emitted: 2, consumed: 0 });
    s = upTo('mInFlight'); // StepStarted attempt 1 consumes the item from the edge whose `from` is its producer
    expect(edgeOf(s, E_SRC_M)).toEqual({ emitted: 2, consumed: 2 });
    expect(edgeOf(s, E_M_LOOP)).toEqual({ emitted: 0, consumed: 0 });
    s = upTo('m0Done'); // StepSucceeded output on port `out` is an emission on edges from `m.out`
    expect(edgeOf(s, E_M_LOOP)).toEqual({ emitted: 1, consumed: 0 });
    s = upTo('mRerun'); // re-run attempts do not consume again
    expect(edgeOf(s, E_SRC_M)).toEqual({ emitted: 2, consumed: 2 });
    s = upTo('entered'); // FrameEntered consumes the item arriving on the frame's `in`
    expect(edgeOf(s, E_M_LOOP)).toEqual({ emitted: 2, consumed: 2 });
    expect(edgeOf(s, E_B1_B2)).toEqual({ emitted: 0, consumed: 0 });
    s = upTo('exitedA'); // body edge between body nodes; frame `out` edge fed by the body exit endpoint loop.b2.out
    expect(edgeOf(s, E_B1_B2)).toEqual({ emitted: 1, consumed: 1 });
    expect(edgeOf(s, E_LOOP_SNK)).toEqual({ emitted: 1, consumed: 0 });
    s = upTo('sinkStarted');
    expect(edgeOf(s, E_LOOP_SNK)).toEqual({ emitted: 2, consumed: 2 });
    s = foldRun(log);
    expect(edgeOf(s, E_SRC_M)).toEqual({ emitted: 2, consumed: 2 });
    expect(edgeOf(s, E_M_LOOP)).toEqual({ emitted: 2, consumed: 2 });
    expect(edgeOf(s, E_B1_B2)).toEqual({ emitted: 2, consumed: 2 });
    expect(edgeOf(s, E_LOOP_SNK)).toEqual({ emitted: 2, consumed: 2 });
  });

  it('EL-7: edge reading pinned on a small fan-out flow (emit per outgoing edge, consume only on the matching target)', () => {
    const fan: Flow = {
      version: 1,
      id: 'fan',
      name: 'fan',
      nodes: {
        src: { kind: 'source', fn: 'range', out: {} },
        m: { kind: 'map', fn: 'identity', in: {}, out: {} },
        s1: { kind: 'sink', fn: 'discard', in: {} },
        s2: { kind: 'sink', fn: 'discard', in: {} },
      },
      edges: [
        { from: { node: 'src', port: 'out' }, to: { node: 'm', port: 'in' } },
        { from: { node: 'm', port: 'out' }, to: { node: 's1', port: 'in' } },
        { from: { node: 'm', port: 'out' }, to: { node: 's2', port: 'in' } },
      ],
    };
    const out = 'src.out#0>m.out#0';
    const s = foldRun(
      toLog([
        created(fan),
        runStarted(1),
        { type: 'ItemEmitted', node: 'src', itemId: 'src.out#0', value: 0 },
        stepStarted('m', 'src.out#0'),
        // two outputs: `out` fans out to s1 and s2, `err` has no outgoing edge (dropped)
        stepOk('m', 'src.out#0', [
          { port: 'out', itemId: out },
          { port: 'err', itemId: 'src.out#0>m.err#0' },
        ]),
        stepStarted('s1', out),
      ]),
    );
    expect(edgeOf(s, 'src.out->m.in')).toEqual({ emitted: 1, consumed: 1 });
    expect(edgeOf(s, 'm.out->s1.in')).toEqual({ emitted: 1, consumed: 1 });
    expect(edgeOf(s, 'm.out->s2.in')).toEqual({ emitted: 1, consumed: 0 });
    expect(s.edges.size).toBe(3);
  });

  it('EL-7: nested frame exit alias is transitive', () => {
    // foreach F { body exit = retry G { body exit = x } } -> snk
    const nested: Flow = {
      version: 1,
      id: 'nested',
      name: 'nested',
      nodes: {
        src: { kind: 'source', fn: 'range', out: {} },
        F: {
          kind: 'frame',
          frame: 'foreach',
          budgets: { maxIterations: 10, maxDurationMs: 1000 },
          concurrency: 1,
          in: {},
          out: {},
          body: {
            nodes: {
              G: {
                kind: 'frame',
                frame: 'retry',
                budgets: { maxIterations: 10, maxDurationMs: 1000 },
                maxAttempts: 3,
                backoff: { kind: 'fixed', baseMs: 1 },
                onExhausted: 'fail-run',
                in: {},
                out: {},
                body: {
                  nodes: { x: { kind: 'map', fn: 'identity', in: {}, out: {} } },
                  edges: [],
                  entry: { node: 'x', port: 'in' },
                  exit: { node: 'x', port: 'out' },
                },
              },
            },
            edges: [],
            entry: { node: 'G', port: 'in' },
            exit: { node: 'G', port: 'out' },
          },
        },
        snk: { kind: 'sink', fn: 'discard', in: {} },
      },
      edges: [
        { from: { node: 'src', port: 'out' }, to: { node: 'F', port: 'in' } },
        { from: { node: 'F', port: 'out' }, to: { node: 'snk', port: 'in' } },
      ],
    };
    const out = 'src.out#0>F.G.x.out#0';
    const s = foldRun(
      toLog([
        created(nested),
        runStarted(1),
        stepStarted('F.G.x', 'src.out#0'),
        stepOk('F.G.x', 'src.out#0', [{ port: 'out', itemId: out }]),
        stepStarted('snk', out),
      ]),
    );
    expect(edgeOf(s, 'F.out->snk.in')).toEqual({ emitted: 1, consumed: 1 });
  });

  it('EL-7: while/until count emitted on the frame out edges from FrameExited.outputs, not per iteration or by reason', () => {
    const first = 'src.out#0';
    const states = [first, `${first}>W.x.out#0`, `${first}>W.x.out#0>W.x.out#0`, `${first}>W.x.out#0>W.x.out#0>W.x.out#0`];
    const body: NewEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      const prev = must(states[i - 1], 'state');
      body.push(
        { type: 'IterationStarted', node: 'W', itemId: first, iteration: i },
        stepStarted('W.x', prev),
        stepOk('W.x', prev, [{ port: 'out', itemId: must(states[i], 'state') }]),
        { type: 'IterationEnded', node: 'W', itemId: first, iteration: i, elapsedMs: 1 },
      );
    }
    const finalState = `${first}>W.out#0`;
    const condExit: NewEvent = {
      type: 'FrameExited',
      node: 'W',
      itemId: first,
      reason: 'condition',
      outputs: [{ port: 'out', itemId: finalState, value: 1 }],
    };
    const head: NewEvent[] = [
      created(whileFlow),
      runStarted(1),
      { type: 'FrameEntered', node: 'W', itemId: first, frame: 'while' },
      ...body,
    ];
    const edge = 'W.out->snk.in';
    expect(edgeOf(foldRun(toLog(head)), edge)).toEqual({ emitted: 0, consumed: 0 });
    const exited = foldRun(
      toLog([...head, condExit]),
    );
    expect(edgeOf(exited, edge)).toEqual({ emitted: 1, consumed: 0 });
    const consumed = foldRun(
      toLog([
        ...head,
        condExit,
        stepStarted('snk', finalState),
      ]),
    );
    expect(edgeOf(consumed, edge)).toEqual({ emitted: 1, consumed: 1 });
    expect(edgeOf(consumed, 'src.out->W.in')).toEqual({ emitted: 0, consumed: 1 });
  });

  it('EL-7: a zero-iteration while still counts its emitted final state from FrameExited.outputs', () => {
    const item = 'src.out#0';
    const final = `${item}>W.out#0`;
    const s = foldRun(
      toLog([
        created(whileFlow),
        runStarted(1),
        { type: 'FrameEntered', node: 'W', itemId: item, frame: 'while' },
        { type: 'FrameExited', node: 'W', itemId: item, reason: 'condition', outputs: [{ port: 'out', itemId: final, value: 1 }] },
        stepStarted('snk', final),
      ]),
    );
    expect(edgeOf(s, 'W.out->snk.in')).toEqual({ emitted: 1, consumed: 1 });
  });

  it('EL-7: FrameExited{condition} without outputs emits nothing', () => {
    const item = 'src.out#0';
    const s = foldRun(
      toLog([
        created(whileFlow),
        runStarted(1),
        { type: 'FrameEntered', node: 'W', itemId: item, frame: 'while' },
        { type: 'FrameExited', node: 'W', itemId: item, reason: 'condition' },
      ]),
    );
    expect(edgeOf(s, 'W.out->snk.in')).toEqual({ emitted: 0, consumed: 0 });
  });

  it('EL-7: retry emit-error counts the error port edge from FrameExited.outputs', () => {
    const retryFlow: Flow = {
      version: 1,
      id: 'r',
      name: 'r',
      nodes: {
        src: { kind: 'source', fn: 'range', out: {} },
        R: {
          kind: 'frame',
          frame: 'retry',
          budgets: { maxIterations: 10, maxDurationMs: 1000 },
          maxAttempts: 2,
          backoff: { kind: 'fixed', baseMs: 1 },
          onExhausted: 'emit-error',
          in: {},
          out: {},
          body: {
            nodes: { x: { kind: 'map', fn: 'identity', in: {}, out: {} } },
            edges: [],
            entry: { node: 'x', port: 'in' },
            exit: { node: 'x', port: 'out' },
          },
        },
        dlq: { kind: 'sink', fn: 'discard', in: {} },
      },
      edges: [
        { from: { node: 'src', port: 'out' }, to: { node: 'R', port: 'in' } },
        { from: { node: 'R', port: 'error' }, to: { node: 'dlq', port: 'in' } },
        { from: { node: 'R', port: 'out' }, to: { node: 'dlq', port: 'in' } },
      ],
    };
    const item = 'src.out#0';
    const err = `${item}>R.error#0`;
    const s = foldRun(
      toLog([
        created(retryFlow),
        runStarted(1),
        { type: 'FrameEntered', node: 'R', itemId: item, frame: 'retry' },
        { type: 'FrameExited', node: 'R', itemId: item, reason: 'retries-exhausted', outputs: [{ port: 'error', itemId: err, value: 'boom' }, { port: 'out', itemId: `${item}>R.out#0`, value: 1 }] },
        stepStarted('dlq', err),
      ]),
    );
    expect(edgeOf(s, 'R.error->dlq.in')).toEqual({ emitted: 1, consumed: 1 });
    // the `out` output on the retries-exhausted event is synthetic: it proves every output is counted, not only outputs[0]
    expect(edgeOf(s, 'R.out->dlq.in').emitted).toBe(1); // every output is emitted, not just outputs[0]
  });

  it('EL-7: a structuredClone\'d state keeps counting edges', () => {
    const n = must(marks.mDone, 'mark mDone');
    const prefix = news.slice(0, n);
    const more: NewEvent[] = [
      { type: 'ItemEmitted', node: 'src', itemId: 'src.out#2', value: 2 },
      stepStarted('m', 'src.out#2'),
    ];
    const extra = toLog([...prefix, ...more]).slice(n);
    const clone = structuredClone(foldRun(toLog(prefix)));
    const twin = foldRun(toLog(prefix));
    for (const e of extra) {
      applyEvent(clone, e);
      applyEvent(twin, e);
    }
    expect(edgeOf(twin, E_SRC_M)).toEqual({ emitted: 3, consumed: 3 });
    expect(edgeOf(clone, E_SRC_M)).toEqual({ emitted: 3, consumed: 3 });
    expect(clone.edges).toEqual(twin.edges);
  });

  it('EL-7: per-frame iterations, active set, elapsedMs and exited', () => {
    const fresh = { iteration: 0, elapsedMs: 0, breached: false };
    let f = frameOf(upTo('entered'), 'loop');
    expect(f).toEqual({
      iterationsStarted: 0,
      iterationsEnded: 0,
      exitedCount: 0,
      active: new Map([[A, fresh], [B, fresh]]),
    });
    f = frameOf(upTo('bodyAStarted'), 'loop');
    expect(f).toMatchObject({ iterationsStarted: 1, iterationsEnded: 0, exitedCount: 0 });
    expect(f.active.get(A)).toEqual({ iteration: 1, elapsedMs: 0, breached: false });
    expect(f.active.get(B)).toEqual(fresh);
    f = frameOf(upTo('exitedA'), 'loop');
    expect(f).toMatchObject({ iterationsStarted: 1, iterationsEnded: 1, exitedCount: 1 });
    expect([...f.active.keys()]).toEqual([B]);
    expect(frameOf(foldRun(log), 'loop')).toEqual({
      iterationsStarted: 2,
      iterationsEnded: 2,
      exitedCount: 2,
      active: new Map(),
    });
  });

  it('EL-7: IterationEnded accumulates elapsedMs per instance, leaving other instances untouched', () => {
    const f = frameOf(
      foldRun(
        toLog([
          created(),
          { type: 'FrameEntered', node: 'loop', itemId: A, frame: 'foreach' },
          { type: 'FrameEntered', node: 'loop', itemId: B, frame: 'foreach' },
          { type: 'IterationStarted', node: 'loop', itemId: A, iteration: 5 },
          { type: 'IterationEnded', node: 'loop', itemId: A, iteration: 5, elapsedMs: 40 },
          { type: 'IterationStarted', node: 'loop', itemId: A, iteration: 7 },
          { type: 'IterationEnded', node: 'loop', itemId: A, iteration: 7, elapsedMs: 15 },
        ]),
      ),
      'loop',
    );
    expect(f).toMatchObject({ iterationsStarted: 2, iterationsEnded: 2 });
    expect(f.active.get(A)).toEqual({ iteration: 7, elapsedMs: 55, breached: false });
    expect(f.active.get(B)).toEqual({ iteration: 0, elapsedMs: 0, breached: false });
  });

  it('EL-7: BudgetExceeded marks only its own frame instance breached', () => {
    const f = frameOf(
      foldRun(
        toLog([
          created(),
          { type: 'FrameEntered', node: 'loop', itemId: A, frame: 'while' },
          { type: 'FrameEntered', node: 'loop', itemId: B, frame: 'while' },
          { type: 'BudgetExceeded', node: 'loop', itemId: A, budget: 'iterations', limit: 3, used: 4 },
        ]),
      ),
      'loop',
    );
    expect(f.active.get(A)?.breached).toBe(true);
    expect(f.active.get(B)?.breached).toBe(false);
  });

  it('EL-7: FrameExited deletes the instance and counts it; events for an unknown instance create nothing', () => {
    const f = frameOf(
      foldRun(
        toLog([
          created(),
          { type: 'FrameEntered', node: 'loop', itemId: A, frame: 'foreach' },
          { type: 'IterationStarted', node: 'loop', itemId: B, iteration: 1 },
          { type: 'IterationEnded', node: 'loop', itemId: B, iteration: 1, elapsedMs: 9 },
          { type: 'BudgetExceeded', node: 'loop', itemId: B, budget: 'time', limit: 1, used: 9 },
          { type: 'FrameExited', node: 'loop', itemId: A, reason: 'input-done', outputs: [] },
        ]),
      ),
      'loop',
    );
    expect(f.active.size).toBe(0);
    expect(f).toMatchObject({ iterationsStarted: 1, iterationsEnded: 1, exitedCount: 1 });
  });

  it('EL-7: committed holds `${node}\\u0000${itemId}` for each StepSucceeded only', () => {
    expect(upTo('mInFlight').committed.size).toBe(0);
    expect(upTo('m0Done').committed).toEqual(new Set(['m\u0000src.out#0']));
    expect(upTo('mFailed').committed).toEqual(new Set(['m\u0000src.out#0']));
    const all = foldRun(log).committed;
    expect(all).toEqual(
      new Set([
        'm\u0000src.out#0',
        'm\u0000src.out#1',
        `loop.b1\u0000${A}`,
        `loop.b1\u0000${B}`,
        `loop.b2\u0000${A1}`,
        `loop.b2\u0000${B1}`,
        `snk\u0000${A2}`,
        `snk\u0000${B2}`,
      ]),
    );
  });

  it('EL-7: sourcesCompleted collects SourceCompleted node ids', () => {
    expect(upTo('mDone').sourcesCompleted.size).toBe(0);
    expect(foldRun(log).sourcesCompleted).toEqual(new Set(['src']));
  });

  it('EL-7: recentErrors records StepFailed and keeps the latest 50', () => {
    const one = foldRun(log).recentErrors;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      seq: must(marks.mFailed, 'mark mFailed'),
      node: 'm',
      itemId: 'src.out#1',
      attempt: 2,
      error: { name: 'Error', message: 'flaky' },
    });

    const failures = Array.from({ length: 120 }, (_, i) => stepFailed('m', `i${i}`, 1, `e${i}`));
    const errors = foldRun(toLog([created(), runStarted(1), ...failures])).recentErrors;
    expect(errors).toHaveLength(50);
    expect(errors.map((e) => e.error.message)).toEqual(Array.from({ length: 50 }, (_, i) => `e${70 + i}`));
  });

  it('EL-7: sideEffects map is keyed by sideEffectKey(node, itemId, key)', () => {
    const s = foldRun(log);
    expect(s.sideEffects.size).toBe(1);
    expect(s.sideEffects.get(sideEffectKey('m', 'src.out#1', 'now'))).toBe(123);
    expect(upTo('m0Done').sideEffects.size).toBe(0);
  });

  it('EL-7: sideEffectKey cannot collide across different (node, itemId, key) splits', () => {
    const triples: [string, string, string][] = [
      ['a.b', 'c', 'k'],
      ['a', 'b.c', 'k'],
      ['a', 'b', 'c.k'],
      ['a>b', 'c#0', 'k'],
      ['a', 'b>c#0', 'k'],
      ['n', 'i:k', 'x'],
      ['n', 'i', 'k:x'],
      ['n:i', 'k', 'x'],
      ['n1', 'i', 'k'], // differs only in node
      ['n2', 'i', 'k'],
    ];
    expect(new Set(triples.map(([n, i, k]) => sideEffectKey(n, i, k))).size).toBe(triples.length);

    const s = foldRun(
      toLog([
        created(),
        { type: 'SideEffect', node: 'a.b', itemId: 'c', key: 'k', value: 1 },
        { type: 'SideEffect', node: 'a', itemId: 'b.c', key: 'k', value: 2 },
        { type: 'SideEffect', node: 'n1', itemId: 'i', key: 'k', value: 3 },
        { type: 'SideEffect', node: 'n2', itemId: 'i', key: 'k', value: 4 },
      ]),
    );
    expect(s.sideEffects.size).toBe(4);
    expect(s.sideEffects.get(sideEffectKey('n1', 'i', 'k'))).toBe(3);
    expect(s.sideEffects.get(sideEffectKey('n2', 'i', 'k'))).toBe(4);
    expect(s.sideEffects.get(sideEffectKey('a.b', 'c', 'k'))).toBe(1);
    expect(s.sideEffects.get(sideEffectKey('a', 'b.c', 'k'))).toBe(2);
  });
});

describe('fold performance', () => {
  // Lazy generator: never materializes the 1M events. 2 + 3 * 333_332 + 2 = 1_000_000.
  function* million(): Generator<LoopworkEvent> {
    const ts = '2026-01-01T00:00:00.000Z';
    yield { type: 'RunCreated', flow, createdBy: 'cli', runId: 'r1', seq: 1, ts };
    yield { type: 'RunStarted', workerId: 'w1', attempt: 1, runId: 'r1', seq: 2, ts };
    let seq = 2;
    for (let i = 0; i < 333_332; i++) {
      const id = `src.out#${i}`;
      yield { type: 'ItemEmitted', node: 'src', itemId: id, value: i, runId: 'r1', seq: ++seq, ts };
      yield { type: 'StepStarted', node: 'm', itemId: id, attempt: 1, runId: 'r1', seq: ++seq, ts };
      yield {
        type: 'StepSucceeded',
        node: 'm',
        itemId: id,
        outputs: [{ port: 'out', itemId: `${id}>m.out#0`, value: i }],
        runId: 'r1',
        seq: ++seq,
        ts,
      };
    }
    yield { type: 'SourceCompleted', node: 'src', count: 333_332, runId: 'r1', seq: ++seq, ts };
    yield { type: 'RunSucceeded', runId: 'r1', seq: ++seq, ts };
  }

  it('fold: 1M events fold in under 5 s', { timeout: 60_000 }, () => {
    const t0 = performance.now();
    const state = foldRun(million());
    const elapsed = performance.now() - t0;
    expect(state.lastSeq).toBe(1_000_000);
    expect(nodeOf(state, 'm').succeeded).toBe(333_332);
    expect(elapsed).toBeLessThan(5000);
  });
});
