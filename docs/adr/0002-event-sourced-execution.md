# 0002. Event-sourced execution on Postgres

## Context
n8n holds run state in memory; large or long runs crash, and debugging means
re-running. We want resume, replay and fork-from-step.

## Decision
Every step result is appended to an event log in Postgres. Run state is a fold
over the log. Postgres also serves as the job queue (`FOR UPDATE SKIP LOCKED`).
Steps must be deterministic given their logged inputs; side effects are logged
as events.

## Consequences
- Crash recovery, deterministic replay and time-travel UI come from one mechanism.
- One datastore to operate; Redis deferred until queue throughput demands it.
- Log grows with run size: needs retention/compaction policy (phase 3).
