import type { T_ev } from '@loopwork/eventlog';
import { win } from '@loopwork/windows';
import { readFileSync } from 'node:fs';

export const g = (e: T_ev) => [e, win, readFileSync];
