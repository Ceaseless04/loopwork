import type { LoopworkEvent, NewEvent, RunRow, RunStatus } from './events.js';

export interface EventStore {
  /** seq 1; fails if runId exists */
  create(runId: string, first: Extract<NewEvent, { type: 'RunCreated' }>): Promise<void>;
  append(runId: string, events: NewEvent[], opts: { expectedSeq: number }): Promise<{ lastSeq: number }>;
  /** ascending */
  read(runId: string, opts?: { fromSeq?: number; limit?: number }): AsyncIterable<LoopworkEvent>;
  /** history then live tail */
  subscribe(runId: string, opts: { fromSeq: number; signal: AbortSignal }): AsyncIterable<LoopworkEvent>;
  getRun(runId: string): Promise<RunRow | undefined>;
  /** newest first */
  listRuns(f: { status?: RunStatus; limit?: number; before?: string }): Promise<RunRow[]>;
}

export class SeqConflictError extends Error {
  readonly code = 'E_SEQ_CONFLICT';
  override readonly name = 'SeqConflictError';
}

export class RunClosedError extends Error {
  readonly code = 'E_RUN_CLOSED';
  override readonly name = 'RunClosedError';
}

export class RunExistsError extends Error {
  readonly code = 'E_RUN_EXISTS';
  override readonly name = 'RunExistsError';
}

export class UnknownRunError extends Error {
  readonly code = 'E_RUN_NOT_FOUND';
  override readonly name = 'UnknownRunError';
}

export class InvalidEventError extends Error {
  readonly code = 'E_BAD_EVENT';
  override readonly name = 'InvalidEventError';
}
