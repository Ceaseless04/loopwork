import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { JsonValue } from '@loopwork/graph';
import { createRegistry, type NodeRegistry } from './registry.js';

type JsonObject = { [key: string]: JsonValue };

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `params[key]`, throwing a TypeError naming the param when it is not of type `type` (absent -> `dflt`). */
function param<T extends 'number' | 'string'>(
  params: JsonValue | undefined,
  key: string,
  type: T,
  dflt?: T extends 'number' ? number : string,
): T extends 'number' ? number : string {
  const v = isObject(params) ? params[key] : undefined;
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== type) throw new TypeError(`param "${key}" must be a ${type}`);
  return v as never;
}

const num = (v: JsonValue | undefined, what: string): number => {
  if (typeof v !== 'number') throw new TypeError(`${what} must be a number`);
  return v;
};

function atPath(state: JsonValue, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = state;
  for (const key of path.split('.')) cur = isObject(cur) ? cur[key] : undefined;
  return cur;
}

/** In-memory built-ins; `writeLine` (default no-op) is the only output path of `logLine`, never stdout. */
export function createBuiltins(opts: { writeLine?: (line: string) => void } = {}): NodeRegistry {
  const writeLine = opts.writeLine ?? (() => {});
  const r = createRegistry();

  r.source('range', async function* (_ctx, params) {
    const count = param(params, 'count', 'number');
    const start = param(params, 'start', 'number', 0);
    for (let i = 0; i < count; i++) yield start + i;
  });
  r.source('fromInput', async function* (ctx) {
    if (!Array.isArray(ctx.input)) throw new TypeError('run input must be an array');
    yield* ctx.input;
  });
  r.source('fromFile', async function* (_ctx, params) {
    const stream = createReadStream(param(params, 'path', 'string'), 'utf8');
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line.trim() !== '') yield JSON.parse(line) as JsonValue;
    } finally {
      lines.close();
      stream.destroy();
    }
  });

  r.map('identity', async (item) => item);
  r.map('sleep', (item, ctx, params) =>
    new Promise((resolve, reject) => {
      const ms = param(params, 'ms', 'number');
      const { signal } = ctx;
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(item);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  );
  r.map('tag', async (item, _ctx, params) => {
    const key = param(params, 'key', 'string');
    const value = isObject(params) ? (params.value ?? null) : null;
    return { ...(isObject(item) ? item : { value: item }), [key]: value };
  });
  r.map('failEvery', async (item, ctx, params) => {
    const n = param(params, 'n', 'number');
    const message = param(params, 'message', 'string');
    const index = /\.out#(\d+)/.exec(ctx.itemId)?.[1];
    if (index !== undefined && (Number(index) + 1) % n === 0) throw new Error(message);
    return item;
  });
  r.map('increment', async (item, _ctx, params) => num(item, 'item') + param(params, 'by', 'number', 1));

  r.sink('discard', async () => {});
  r.sink('logLine', async (item) => writeLine(JSON.stringify(item)));

  r.predicate('lessThan', async (state, _ctx, params) => {
    const v = atPath(state, param(params, 'path', 'string'));
    const limit = param(params, 'value', 'number');
    return typeof v === 'number' && v < limit;
  });
  r.predicate('truthy', async (state, _ctx, params) => Boolean(atPath(state, param(params, 'path', 'string'))));

  return r;
}
