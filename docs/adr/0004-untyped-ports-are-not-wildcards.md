# 0004. Untyped (`{}`) ports are not wildcards in wiring checks

## Context
`SPEC-graph-model.md` defines `isAssignable(from, to)` as "from's values are always acceptable to `to`" and
`E_TYPE_MISMATCH` as "an edge's `from` schema is not assignable to its `to` schema". The any-schema `{}` accepts every
JSON value, so as a SOURCE it produces unconstrained values. The Phase 1 plan's T16 tests said "`{}` passes both ways",
which would make `{}` a wildcard in both directions and contradict the sound definition (found in the T11 review).

## Decision
`isAssignable` stays sound. In `validateFlow` (T16) wiring checks:
- `X -> {}` passes (anything is acceptable to an untyped target);
- `{} -> {}` passes;
- `{} -> typed` is `E_TYPE_MISMATCH`, with a message telling the author to type the producing port
  (for example with `inferFrom` samples).
No special case for the any-schema is added to the validator. Loosening later (a gradual-typing mode that warns instead
of failing) is backward compatible; tightening later is not, so the strict reading ships first.

## Consequences
- Users must type the outputs of untyped producers before wiring them to typed consumers.
- The T16 plan line "`{}` passes both ways" is superseded by this ADR: tests assert the three cases above.
- A future "explain" API (why is this edge a mismatch?) and a gradual mode are possible additive follow-ups; neither is in Phase 1.
