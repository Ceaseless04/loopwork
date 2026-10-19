# 0001. Loops are frames, not back-edges

## Context
n8n models loops as back-edges on a general graph. Users hit loops that never
finish, silent partial runs, and unreadable control flow.

## Decision
Cycles are only allowed inside loop frames (`ForEach`, `While/Until`, `Retry`,
`Map-Reduce`, `Paginate`, `Agent`). The outer graph must be a DAG. Every frame
declares an exit condition and budgets (iterations, time, cost, tokens).

## Consequences
- Graph is statically validatable, schedulable and auto-layoutable.
- Runaway loops become validation errors or budget stops, not hangs.
- Arbitrary goto-style cycles are impossible; users needing them nest frames.
