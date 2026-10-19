import type { Flow, JsonValue } from '@loopwork/graph';

export type NewEvent =
  | { type: 'RunCreated'; flow: Flow; input?: JsonValue; createdBy: 'cli' | 'mcp' | 'ui' | 'api' }
  | { type: 'RunStarted'; workerId: string; attempt: number } // each (re)take of the run
  | { type: 'RunSucceeded' }
  | { type: 'RunFailed'; reason: 'step' | 'budget' | 'crash-loop' | 'internal'; message: string; node?: string }
  | { type: 'RunCancelled'; requestedBy?: string }
  | { type: 'ItemEmitted'; node: string; itemId: string; value: JsonValue } // source output
  | { type: 'SourceCompleted'; node: string; count: number }
  | { type: 'StepStarted'; node: string; itemId: string; attempt: number }
  | {
      type: 'StepSucceeded';
      node: string;
      itemId: string;
      outputs: { port: string; itemId: string; value: JsonValue }[];
    }
  | {
      type: 'StepFailed';
      node: string;
      itemId: string;
      attempt: number;
      error: { name: string; message: string; stack?: string };
      willRetry: boolean;
    }
  | { type: 'SideEffect'; node: string; itemId: string; key: string; value: JsonValue } // 'now' | 'random' | caller keys
  | { type: 'FrameEntered'; node: string; itemId: string; frame: 'foreach' | 'while' | 'until' | 'retry' }
  | { type: 'IterationStarted'; node: string; itemId: string; iteration: number }
  | { type: 'IterationEnded'; node: string; itemId: string; iteration: number; elapsedMs: number }
  | {
      type: 'FrameExited';
      node: string;
      itemId: string;
      reason: 'input-done' | 'condition' | 'success' | 'retries-exhausted';
      outputs?: { port: string; itemId: string; value: JsonValue }[];
    }
  | { type: 'BudgetExceeded'; node: string; itemId: string; budget: 'iterations' | 'time'; limit: number; used: number };

export type LoopworkEvent = NewEvent & { runId: string; seq: number; ts: string /* ISO-8601 */ };

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type RunRow = {
  runId: string;
  flowId: string;
  flowName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
};

// `satisfies` rejects a name that is not in the union; `_AllListed` rejects a union member missing from the list.
// Both bite only under the root `pnpm typecheck`; vitest strips types.
export const EVENT_TYPES = [
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
] as const satisfies readonly NewEvent['type'][];

type _AllListed = [Exclude<NewEvent['type'], (typeof EVENT_TYPES)[number]>] extends [never] ? true : never;
const allListed: _AllListed = true;
void allListed;
