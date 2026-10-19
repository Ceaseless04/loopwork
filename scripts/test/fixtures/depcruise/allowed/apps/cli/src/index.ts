import type { T_gr } from '@loopwork/graph';
import type { T_ev } from '@loopwork/eventlog';
import { sv } from '@loopwork/service';
import { win } from '@loopwork/windows';

export const cli = (g: T_gr, e: T_ev) => [g, e, sv, win];
export const load = () => import('@loopwork/claude-integration');
