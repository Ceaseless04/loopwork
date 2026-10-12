# Loopwork plan

## Gaps in n8n we target
| Area | n8n today | Loopwork |
|---|---|---|
| Loops | "Loop Over Items" + back-edge; loops that never hit "done", silent partial runs, no native while/until | Loops are first-class typed frames with budgets |
| Execution | Looks parallel, runs branch by branch; whole arrays in memory | Streaming items, real concurrency, backpressure |
| Debugging | Generic errors, silent failures, disable-nodes-to-bisect | Time-travel, per-iteration inspection, fork-from-step |
| Composition | Sub-workflow races, hard to test, Git via JSON export | Typed, versioned subgraphs, Git-native |
| License | Fair-code (not OSI) | Apache-2.0 core |

## 1. Graph engine
- **Loops are frames, not back-edges.** Cycles only inside `ForEach`, `While/Until`,
  `Retry`, `Map-Reduce`, `Paginate`, `Agent`. Outer graph stays a DAG.
- **Mandatory budgets** per frame: max iterations / time / cost / tokens + explicit exit.
- **Streaming items** with concurrency limit and backpressure.
- **Durable, event-sourced runs** (append-only log in Postgres): resume after crash,
  deterministic replay, fork from any step.
- **Typed ports**: schemas inferred from samples; bad wiring fails before run.

## 2. Fluid UI/UX
- Semantic zoom: frames collapse to live summary cards.
- Live edges: item counts, throughput, errors during a run.
- Loop scrubber: timeline per frame; jump to iteration N and see its I/O.
- Keyboard-first: command palette, type-to-insert, auto-layout.
- Bidirectional graph-as-code: canvas <-> `.flow.ts`, visual Git diffs.

## 3. Integrations
- OpenAPI-generated connectors, MCP servers as tools, HTTP + sandboxed code step.
- No race to 500 hand-written nodes; hand-write only what usage demands.

## Stack
- TypeScript monorepo; Node engine; React + React Flow (xyflow).
- Postgres for event log and queue (`SKIP LOCKED`); Redis only if throughput demands.
- Code steps in isolated-vm or a Deno subprocess. Multiplayer (Yjs) later.

## Phases
1. **Engine MVP** - typed graph, ForEach/While/Retry frames, streaming, event log, CLI runner.
   Exit: 100k-item loop with concurrency limit completes and survives `kill -9` mid-run.
2. **Canvas** - frames, live edges, auto-layout, command palette, `.flow.ts` sync.
3. **Debugging** - loop scrubber, replay/fork-from-step, iteration-precise errors.
4. **AI** - `Agent` frame with token/cost budgets, MCP tools, human approval, evals on replayed logs.
5. **Teams** - versioned subgraph packages, multiplayer, RBAC, self-host + cloud.

## Not now
Node marketplace, enterprise SSO, hosted cloud - revisit after phase 3 proves the loop-first wedge.
