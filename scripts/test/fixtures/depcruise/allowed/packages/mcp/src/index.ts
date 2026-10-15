import type { T_gr } from '@loopwork/graph';
import type { T_ev } from '@loopwork/eventlog';
import { sv, type T_sv } from '@loopwork/service';

export const fd = (g: T_gr, e: T_ev, s: T_sv) => [g, e, s, sv];
