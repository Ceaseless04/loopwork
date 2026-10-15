import type { Flow } from '@loopwork/graph';
import { describe, expect, it } from 'vitest';
import type { NewEvent, RunStatus } from '../src/events.js';
import { assertAppendAllowed, nextStatus } from '../src/status.js';
import { InvalidEventError, RunClosedError } from '../src/store.js';

const created = (): NewEvent => ({ type: 'RunCreated', flow: {} as Flow, createdBy: 'cli' });
const started = (attempt: number): NewEvent => ({ type: 'RunStarted', workerId: 'w1', attempt });
const succeeded = (): NewEvent => ({ type: 'RunSucceeded' });
const failed = (): NewEvent => ({ type: 'RunFailed', reason: 'internal', message: 'boom' });
const cancelled = (): NewEvent => ({ type: 'RunCancelled' });
const stepStarted = (): NewEvent => ({ type: 'StepStarted', node: 'n', itemId: 'i', attempt: 1 });

const closed = (current: RunStatus, lastAttempt: number, events: NewEvent[]): void => {
  expect(() => assertAppendAllowed(current, lastAttempt, events)).toThrow(RunClosedError);
  try {
    assertAppendAllowed(current, lastAttempt, events);
  } catch (e) {
    expect((e as RunClosedError).code).toBe('E_RUN_CLOSED');
  }
};

describe('status rules', () => {
  it('EL-4: after a terminal event appends are rejected with E_RUN_CLOSED', () => {
    const terminal: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
    const events: [string, NewEvent][] = [
      ['StepStarted', stepStarted()],
      ['RunSucceeded', succeeded()],
      ['RunFailed', failed()],
      ['RunCancelled', cancelled()],
    ];
    for (const status of terminal) {
      for (const [name, event] of events) {
        try {
          closed(status, 1, [event]);
        } catch (e) {
          throw new Error(`${status} x ${name}: ${(e as Error).message}`);
        }
      }
    }
  });

  it('EL-4: non-terminal runs accept appends, RunStarted included', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(() => assertAppendAllowed(status, 1, [stepStarted(), succeeded()])).not.toThrow();
      expect(() => assertAppendAllowed(status, 1, [started(2)])).not.toThrow();
    }
  });

  it('EL-4: RunStarted with a higher attempt on a failed run is accepted and flips status to running', () => {
    expect(() => assertAppendAllowed('failed', 1, [started(2)])).not.toThrow();
    expect(() => assertAppendAllowed('failed', 1, [started(2), stepStarted()])).not.toThrow();
    expect(nextStatus('failed', started(2))).toBe('running');
  });

  it.each([
    ['same', 2],
    ['lower', 1],
  ])('EL-4: RunStarted with a %s attempt on a failed run is rejected with E_RUN_CLOSED', (_name, attempt) => {
    closed('failed', 2, [started(attempt)]);
  });

  it.each(['succeeded', 'cancelled'] as const)('EL-4: %s never reopens, even for a higher attempt', (status) => {
    closed(status, 1, [started(2)]);
    closed(status, 1, [started(99)]);
  });

  it('EL-4: events after a terminal event in the same batch are rejected', () => {
    closed('running', 1, [failed(), stepStarted()]);
    closed('running', 1, [succeeded(), stepStarted()]);
    closed('queued', 0, [cancelled(), succeeded()]);
    closed('running', 1, [succeeded(), started(2)]);
    closed('running', 1, [cancelled(), started(2)]);
  });

  it('EL-4: a resume RunStarted in the same batch must beat the attempt of the earlier one', () => {
    expect(() => assertAppendAllowed('running', 1, [failed(), started(2)])).not.toThrow();
    expect(() => assertAppendAllowed('running', 1, [failed(), started(2), failed(), started(3)])).not.toThrow();
    closed('running', 1, [failed(), started(1)]);
    closed('running', 1, [failed(), started(2), failed(), started(2)]);
  });

  it('EL-4: an empty batch is allowed in every status', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(() => assertAppendAllowed(status, 1, [])).not.toThrow();
    }
  });

  it('EL-4: RunCreated in an append is rejected with E_BAD_EVENT', () => {
    expect(() => assertAppendAllowed('queued', 0, [created()])).toThrow(InvalidEventError);
    expect(() => assertAppendAllowed('running', 1, [stepStarted(), created()])).toThrow(InvalidEventError);
    try {
      assertAppendAllowed('queued', 0, [created()]);
    } catch (e) {
      expect((e as InvalidEventError).code).toBe('E_BAD_EVENT');
    }
  });

  it.each([
    [undefined, created(), 'queued'],
    ['running', created(), 'queued'], // total: RunCreated => queued regardless of current
    ['queued', started(1), 'running'],
    ['running', started(2), 'running'],
    ['failed', started(2), 'running'],
    ['running', succeeded(), 'succeeded'],
    ['running', failed(), 'failed'],
    ['queued', cancelled(), 'cancelled'],
    ['queued', stepStarted(), 'queued'], // any other event leaves status unchanged
    ['running', stepStarted(), 'running'],
  ] as const)('EL-4: nextStatus(%s, %o) is %s', (current, event, expected) => {
    expect(nextStatus(current, event)).toBe(expected);
  });

  it('EL-4: nextStatus throws E_BAD_EVENT for a non-lifecycle event before RunCreated', () => {
    expect(() => nextStatus(undefined, stepStarted())).toThrow(InvalidEventError);
    try {
      nextStatus(undefined, stepStarted());
    } catch (e) {
      expect((e as InvalidEventError).code).toBe('E_BAD_EVENT');
    }
  });
});
