import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/events.js';
import type { RunStatus } from '../src/events.js';
import { assertAppendAllowed, nextStatus } from '../src/status.js';
import { genValidLog } from './valid-log.js';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('genValidLog', () => {
  it('EL-6: every generated log is accepted by assertAppendAllowed, batch by batch', () => {
    for (const seed of SEEDS) {
      const [first, ...rest] = genValidLog(seed);
      expect(first?.type, `seed ${seed}`).toBe('RunCreated');
      let status: RunStatus = 'queued';
      let lastAttempt = 0;
      for (let i = 0; i < rest.length; i += 3) {
        const batch = rest.slice(i, i + 3);
        expect(() => assertAppendAllowed(status, lastAttempt, batch), `seed ${seed} batch at ${i}`).not.toThrow();
        for (const e of batch) {
          status = nextStatus(status, e);
          if (e.type === 'RunStarted') lastAttempt = Math.max(lastAttempt, e.attempt);
        }
      }
    }
  });

  it('EL-6: the same seed gives the same log and different seeds differ', () => {
    expect(genValidLog(7)).toEqual(genValidLog(7));
    expect(genValidLog(7)).not.toEqual(genValidLog(8));
    expect(new Set(SEEDS.map((s) => JSON.stringify(genValidLog(s)))).size).toBe(SEEDS.length);
  });

  it('EL-6: over 200 seeds the logs cover every event type, resumes and every final status', () => {
    const types = new Set<string>();
    const finals = new Set<RunStatus>();
    let resumed = 0;
    let retryTrue = false;
    let retryFalse = false;
    for (const seed of SEEDS) {
      const log = genValidLog(seed);
      let status: RunStatus | undefined;
      for (const e of log) {
        types.add(e.type);
        status = nextStatus(status, e);
        if (e.type === 'StepFailed') {
          if (e.willRetry) retryTrue = true;
          else retryFalse = true;
        }
      }
      if (status) finals.add(status);
      if (log.filter((e) => e.type === 'RunStarted').length > 1) resumed++;
    }
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
    expect([...finals].sort()).toEqual(['cancelled', 'failed', 'queued', 'running', 'succeeded']);
    expect(resumed).toBeGreaterThan(0);
    expect(retryTrue && retryFalse).toBe(true);
  });

  it('EL-6: maxEvents is honoured and the default is about 60', () => {
    for (const seed of SEEDS) {
      expect(genValidLog(seed, { maxEvents: 12 }).length, `seed ${seed}`).toBeLessThanOrEqual(12);
      expect(genValidLog(seed).length, `seed ${seed}`).toBeLessThanOrEqual(60);
    }
    expect(genValidLog(1, { maxEvents: 1 })).toHaveLength(1);
  });
});
