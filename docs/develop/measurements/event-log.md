# Event log measurements (PgStore)

Measured 2026-10-14 against the existing `PgStore` (branch `feat/phase1-foundation`, HEAD 57def17 plus the T31 tests).
These are one-off numbers from a local machine, not CI numbers; recalibrate after the first CI run.

## Machine

- WSL2 (Linux 6.18) on Windows, Intel i7-13620H (16 logical CPUs), 7 GiB RAM visible to WSL.
- Postgres 16 in docker (`loopwork-test`), data dir on tmpfs, reached over loopback (127.0.0.1:55432).
- Node v20.20.2, `pg` Pool with default settings (max 10), one connection per transaction.

## EL-8: 100k events in batches of 500 (spec target: < 20 s)

Scenario: `create` (RunCreated) then 99,999 `ItemEmitted` events in 200 `append` calls of at most 500; wall time of the
whole sequence, fresh schema per run, 5 runs.

| run | ms |
| --- | --- |
| 1 | 6877 |
| 2 | 5948 |
| 3 | 6039 |
| 4 | 5788 |
| 5 | 5800 |

median 5948 ms, min 5788 ms, max 6877 ms (about 3.4x headroom under the 20 s target; run 1 includes JIT/connection warm-up).

## Single-event append latency

500 sequential one-event `append` calls (expectedSeq tracked), wall time per call:

| run length | p50 | p99 |
| --- | --- | --- |
| fresh run (1 to 501 events) | 7.3 ms | 12.8 ms |
| after 100k events (100,000 to 100,500) | 20.6 ms | 37.1 ms |

Latency grows with run length: `append` runs `select max(payload->>'attempt') from events where run_id = $1 and type = 'RunStarted'`
and there is no index on `type`, so it reads every event of the run on each append. Not a problem at the 20 s target, but
a long run pays it on every append (a partial index on `(run_id) where type = 'RunStarted'`, or keeping the last attempt
on `runs`, would remove it).

## EL-10: constant-memory reads

`pageSize` 1,000, run of 50,321 events (not a multiple of the page size, so the page count is exact):

- 51 page queries = ceil(50,321 / 1,000): 50 pages of 1,000 rows and one of 321; no page above `pageSize`.
- No page query contains `OFFSET` (keyset on `(run_id, seq)`).
- A consumer that breaks after 1,500 events has triggered exactly 2 page queries and none after.

The 1M-event figure from the spec is not materialised (the property does not depend on run length).
