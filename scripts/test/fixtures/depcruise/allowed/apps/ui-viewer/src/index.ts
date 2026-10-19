import { gr } from '@loopwork/graph';
import type { T_sv } from '@loopwork/service';

export const uv = (s: T_sv) => [gr, s, fetch('/api/runs')];
