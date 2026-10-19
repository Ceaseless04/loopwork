import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@loopwork/graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltins } from '../src/builtins.js';
import type { PredicateContext, StepContext } from '../src/registry.js';

const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  runId: 'r1',
  node: 'n',
  itemId: 'n.out#0',
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: 'k',
  input: undefined,
  now: () => 0,
  random: () => 0,
  ...over,
});
const pctx: PredicateContext = { runId: 'r1', node: 'p', itemId: 'p#0', signal: new AbortController().signal };

const collect = async (it: AsyncIterable<JsonValue>): Promise<JsonValue[]> => {
  const out: JsonValue[] = [];
  for await (const v of it) out.push(v);
  return out;
};
const b = createBuiltins();
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('built-in missing');
  return v;
};
const map = (name: string) => need(b.get('map', name));

afterEach(() => vi.useRealTimers());

describe('builtins: sources', () => {
  it('builtins: range emits count values from start (default 0)', async () => {
    const range = need(b.get('source', 'range'));
    expect(await collect(range(ctx(), { count: 3 }))).toEqual([0, 1, 2]);
    expect(await collect(range(ctx(), { count: 2, start: 10 }))).toEqual([10, 11]);
  });

  it('builtins: fromInput yields the run input array elements and rejects a non-array', async () => {
    const fromInput = need(b.get('source', 'fromInput'));
    expect(await collect(fromInput(ctx({ input: [1, 'a', { x: 2 }] }), undefined))).toEqual([1, 'a', { x: 2 }]);
    await expect((async () => collect(fromInput(ctx({ input: 5 }), undefined)))()).rejects.toThrow();
    // an iterable non-array must be rejected too, not spread into characters
    await expect((async () => collect(fromInput(ctx({ input: 'ab' }), undefined)))()).rejects.toThrow();
  });

  it('builtins: fromFile streams NDJSON and skips blank lines', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lw-ndjson-')), 'in.ndjson');
    writeFileSync(path, '{"a":1}\n2\n\n"x"\n\n');
    expect(await collect(need(b.get('source', 'fromFile'))(ctx(), { path }))).toEqual([{ a: 1 }, 2, 'x']);
  });
});

describe('builtins: maps', () => {
  it('builtins: names(map) lists exactly the five maps', () => {
    expect([...b.names('map')].sort()).toEqual(['failEvery', 'identity', 'increment', 'sleep', 'tag']);
  });

  it('builtins: identity returns the item', async () => {
    expect(await map('identity')({ a: [1] }, ctx(), undefined)).toEqual({ a: [1] });
  });

  it('builtins: sleep waits ms on the timer, returns the item, and rejects on abort', async () => {
    vi.useFakeTimers();
    const p = map('sleep')(7, ctx(), { ms: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(7);

    const ac = new AbortController();
    const aborted = map('sleep')(7, ctx({ signal: ac.signal }), { ms: 100 });
    const assertion = expect(aborted).rejects.toBeTruthy();
    ac.abort();
    await assertion;

    // an already-aborted signal rejects without waiting for the timer (no abort event will ever fire)
    const pre = map('sleep')(7, ctx({ signal: AbortSignal.abort() }), { ms: 100 });
    const preAssertion = expect(pre).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(100);
    await preAssertion;
  });

  it('builtins: tag merges into objects and wraps non-objects', async () => {
    const tag = map('tag');
    expect(await tag({ a: 1 }, ctx(), { key: 't', value: 'v' })).toEqual({ a: 1, t: 'v' });
    expect(await tag(5, ctx(), { key: 't', value: 'v' })).toEqual({ value: 5, t: 'v' });
  });

  it('builtins: failEvery fails exactly when (source index + 1) % n === 0', async () => {
    const failEvery = map('failEvery');
    const params = { n: 3, message: 'boom' };
    const run = (i: number, itemId = `src.out#${i}`) => failEvery(i, ctx({ itemId }), params);
    await expect(run(2)).rejects.toThrow('boom');
    await expect(run(5)).rejects.toThrow('boom');
    for (const i of [0, 1, 3, 4]) await expect(run(i)).resolves.toBe(i);
    // the FIRST #<digits> in the id is the source index, later ones are fan-out positions
    await expect(run(0, 'src.out#2>m.out#0')).rejects.toThrow('boom');
  });

  it('builtins: increment adds by (default 1) and rejects a non-number item', async () => {
    const increment = map('increment');
    expect(await increment(1, ctx(), undefined)).toBe(2);
    expect(await increment(1, ctx(), { by: 5 })).toBe(6);
    await expect(increment('a', ctx(), undefined)).rejects.toThrow();
  });
});

describe('builtins: sinks', () => {
  it('builtins: discard resolves and registry has no pgIdempotent', async () => {
    await expect(need(b.get('sink', 'discard'))({ a: 1 }, ctx(), undefined)).resolves.toBeUndefined();
    expect(b.has('sink', 'pgIdempotent')).toBe(false);
  });

  it('builtins: logLine passes JSON to the injected writer; the default writer writes nothing to stdout', async () => {
    const lines: string[] = [];
    await need(createBuiltins({ writeLine: (l) => lines.push(l) }).get('sink', 'logLine'))({ a: 1 }, ctx(), undefined);
    expect(lines).toEqual(['{"a":1}']);

    // default writer is a silent no-op: resolves, and the earlier injected writer is not shared/called
    await expect(need(b.get('sink', 'logLine'))({ b: 2 }, ctx(), undefined)).resolves.toBeUndefined();
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe('builtins: predicates', () => {
  it('builtins: lessThan and truthy read a dotted path', async () => {
    const state = { stats: { n: 3, ok: true, zero: 0 } };
    const lessThan = need(b.get('predicate', 'lessThan'));
    const truthy = need(b.get('predicate', 'truthy'));
    expect(await lessThan(state, pctx, { path: 'stats.n', value: 5 })).toBe(true);
    expect(await lessThan(state, pctx, { path: 'stats.n', value: 3 })).toBe(false);
    expect(await truthy(state, pctx, { path: 'stats.ok' })).toBe(true);
    expect(await truthy(state, pctx, { path: 'stats.zero' })).toBe(false);
  });
});
