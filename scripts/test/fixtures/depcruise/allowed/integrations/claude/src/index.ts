import type { T_gr } from '@loopwork/graph';
import type { T_ev } from '@loopwork/eventlog';
import type { T_helper } from '../../../apps/cli/src/helper';
import { sv } from '@loopwork/service';

export const cl = (g: T_gr, e: T_ev, h: T_helper) => [g, e, h, sv];
