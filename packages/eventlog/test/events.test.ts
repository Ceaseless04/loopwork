import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/events.js';
import type { NewEvent } from '../src/events.js';
import {
  InvalidEventError,
  RunClosedError,
  RunExistsError,
  SeqConflictError,
  UnknownRunError,
} from '../src/store.js';
import type { EventStore } from '../src/store.js';

// Type pins only bite under the root `pnpm typecheck`; vitest strips types and never checks them.
// `pin<Equal<A, B>>(true)` compiles only when the two types are identical.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const pin = <T extends true>(value: T): T => value;

// The 16 `type` names of the NewEvent union in SPEC-event-log.md, in spec order.
const SPEC_EVENT_TYPES = [
  'RunCreated',
  'RunStarted',
  'RunSucceeded',
  'RunFailed',
  'RunCancelled',
  'ItemEmitted',
  'SourceCompleted',
  'StepStarted',
  'StepSucceeded',
  'StepFailed',
  'SideEffect',
  'FrameEntered',
  'IterationStarted',
  'IterationEnded',
  'FrameExited',
  'BudgetExceeded',
];

describe('event types', () => {
  it('T24: EVENT_TYPES lists exactly the 16 NewEvent type names', () => {
    expect([...EVENT_TYPES]).toEqual(SPEC_EVENT_TYPES);
    // Compile-time exhaustiveness: no union member missing from the list, none extra.
    pin<Equal<(typeof EVENT_TYPES)[number], NewEvent['type']>>(true);
  });
});

describe('EventStore', () => {
  it('T24: a minimal object literal satisfies the EventStore interface', () => {
    const store: EventStore = {
      create: () => Promise.resolve(),
      append: () => Promise.resolve({ lastSeq: 0 }),
      read: async function* () {
        // empty stream
      },
      subscribe: async function* () {
        // empty stream
      },
      getRun: () => Promise.resolve(undefined),
      listRuns: () => Promise.resolve([]),
    };
    expect(Object.keys(store).sort()).toEqual(['append', 'create', 'getRun', 'listRuns', 'read', 'subscribe']);
  });
});

describe('store errors', () => {
  const cases = [
    ['SeqConflictError', SeqConflictError, 'E_SEQ_CONFLICT'],
    ['RunClosedError', RunClosedError, 'E_RUN_CLOSED'],
    ['RunExistsError', RunExistsError, 'E_RUN_EXISTS'],
    ['UnknownRunError', UnknownRunError, 'E_RUN_NOT_FOUND'],
    ['InvalidEventError', InvalidEventError, 'E_BAD_EVENT'],
  ] as const;

  it.each(cases)('T24: %s carries a stable code, name, message, and instanceof', (name, Ctor, code) => {
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Ctor);
    expect(err.code).toBe(code);
    expect(err.name).toBe(name);
    expect(err.message).toBe('boom');
  });
});
