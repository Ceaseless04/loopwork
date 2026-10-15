import { describe, expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';
import type { EventStore, LoopworkEvent, NewEvent, RunRow, RunState, RunStatus } from '../src/index.js';

describe('@loopwork/eventlog public API', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'EVENT_TYPES',
        'InvalidEventError',
        'MemoryStore',
        'MigrationConflictError',
        'PgStore',
        'RunClosedError',
        'RunExistsError',
        'SchemaTooNewError',
        'SeqConflictError',
        'UnknownRunError',
        'applyEvent',
        'assertAppendAllowed',
        'emptyRunState',
        'foldRun',
        'migrate',
        'nextStatus',
        'sideEffectKey',
        'statusOf',
      ].sort(),
    );
  });

  // Type pins bite only under the root `pnpm typecheck` (vitest strips types).
  it('exposes the event/store/fold types', () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>();
    expectTypeOf<LoopworkEvent>().toMatchTypeOf<NewEvent>();
    expectTypeOf<RunRow['lastSeq']>().toBeNumber();
    expectTypeOf<api.MemoryStore>().toMatchTypeOf<EventStore>();
    expectTypeOf<api.PgStore>().toMatchTypeOf<EventStore>();
    expectTypeOf(api.emptyRunState).returns.toEqualTypeOf<RunState>();
    expectTypeOf(api.foldRun).returns.toEqualTypeOf<RunState>();
    expectTypeOf(api.statusOf).parameter(0).toEqualTypeOf<RunState>();
    expectTypeOf(api.applyEvent).returns.toEqualTypeOf<RunState>();
    expectTypeOf<ConstructorParameters<typeof api.PgStore>[1]>().toEqualTypeOf<
      { pageSize?: number; pollMs?: number; now?: () => Date } | undefined
    >();
  });
});
