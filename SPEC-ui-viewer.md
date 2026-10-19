# Spec: ui-viewer (`apps/ui-viewer`)

Depends on: `ui-server` (HTTP/SSE contract only; shared TS types via `import type` from `@loopwork/service` and `@loopwork/graph`). Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

The GUI window: an **interactive** single-page app where you pick or paste a flow, start it, watch items stream along
edges and frames iterate in real time, drill into errors, and resume or cancel a run. It is where "the canvas is the
runtime" starts being true; Phase 2 adds editing to this same app. It does not edit graphs in Phase 1.

## Tech Stack

React 18, `@xyflow/react` (React Flow), Vite, TypeScript, vitest + `@testing-library/react` + jsdom. Plain CSS (custom properties, no CSS framework). Hash routing by hand (`#/runs/<id>`), no router library. One Playwright smoke test is the only browser-driven test, and Playwright is a **dev dependency that needs your approval** (see Open Questions).

## Commands

```
pnpm --filter ui-viewer dev          # Vite dev server, proxies /api to a running `loopwork ui --no-open`
pnpm --filter ui-viewer build        # outputs dist/ consumed by claude-integration
pnpm --filter ui-viewer test         # component + logic tests
pnpm --filter ui-viewer test:smoke   # Playwright, headless (after approval)
```

## Project Structure

```
apps/ui-viewer/
  src/main.tsx, App.tsx
  src/api/client.ts        typed fetch wrappers (credentials: 'same-origin'), error normalisation
  src/api/stream.ts        SSE hook with reconnect + backoff + status
  src/state/               runs store (list + selected run view), reducers
  src/graph/layout.ts      layered layout of Flow -> node/edge positions (pure)
  src/graph/FlowCanvas.tsx React Flow wrapper, read-only graph
  src/graph/nodes/         SourceNode, MapNode, SinkNode, FrameNode (collapsible group)
  src/graph/edge.tsx       LiveEdge: count + items/s label
  src/panels/              RunList, Launcher, RunHeader, ErrorPanel, FrameInspector
  src/lib/rate.ts          items/s from successive views (pure)
  test/
```

## Screens and behaviour

**Layout.** Left: run list (status chip, flow name, relative time, progress) with a search box. Top-right: `RunHeader` (name, status, elapsed, Resume/Cancel).
Centre: graph. Right (collapsible): `ErrorPanel` / `FrameInspector`. A `Launcher` dialog (`s` or "New run") lists `flowsDir` flows and has a JSON editor tab for pasting a flow, a JSON input box, inline validation errors from `/api/validate`, and **Start**.

**Live graph.**
- Nodes show kind icon, id, a state badge (idle / running / done / failed: **icon + text**, never colour alone), and `succeeded/failed/inFlight` counts.
- `LiveEdge` shows `emitted` count and items/s (computed client-side from successive views over a 3 s window), animated dashes while `consumed < emitted`; animation off under `prefers-reduced-motion`.
- Frames render as group nodes: **semantic zoom** collapses a frame to a summary card (`kind`, `iteration n / limit`, a time budget bar, active instances) below a zoom threshold or when collapsed by the user; expanding shows the body nodes in place.
- Budget bars turn to a warning style at 80% and an error style when `BudgetExceeded`; text states the numbers.
- Layout is a deterministic layered layout (longest-path layering, stable ordering) computed from `Flow`; positions never jump between updates (only recomputed on a new flow).

**Interaction.** `Resume` enabled only when the view's status allows it (same rules as `run-service`; the server stays the authority and the button handles a 409); `Cancel` asks for confirmation
and shows `cancelling…` until the terminal status arrives. Clicking an error focuses the node. `/` focuses run search, `s` opens Launcher, `Esc` closes dialogs, arrow keys move in the run list, `Enter` opens.

**Connection.** Header shows a `live | reconnecting | offline` indicator. On SSE drop the hook reconnects with backoff (0.5 s → 8 s); views are idempotent (full `RunView` each message). A run in `stalled` shows a banner ("worker not responding, it will resume automatically").

**Empty/error states.** No runs: a one-line explainer plus the Launcher button. Server unreachable: full-panel message with the `loopwork doctor` hint. Unknown run id in the hash: not-found state with a link to the list.

**Accessibility.** Fully keyboard operable; visible focus; ARIA live region announces status changes (`run succeeded`, `run failed: …`); contrast ≥ 4.5:1 in light and dark themes (`prefers-color-scheme`); graph has a text alternative (a table view toggle listing nodes and counts).

**Performance.** The store keeps only the latest `RunView` per open run; React Flow nodes are memoised and only nodes whose counts changed re-render; target 10 view updates/s on a 200-node flow without dropped frames (see criteria).

## Code Style

```tsx
export function LiveEdge({ id, data, ...p }: EdgeProps<EdgeData>) {
  const rate = useItemsPerSecond(data.emitted);
  return <BaseEdge id={id} {...p} className={data.consumed < data.emitted ? 'edge flowing' : 'edge'}
                   label={`${fmt(data.emitted)}${rate ? ` · ${rate}/s` : ''}`} />;
}
```
Pure logic (layout, rate, reducers) lives in plain `.ts` files with tests; components stay thin.

## Testing Strategy

- Unit: `layout`, `rate`, store reducers, API error normalisation.
- Component (jsdom + Testing Library): Launcher, RunList keyboard nav, RunHeader button states, ErrorPanel, FrameNode collapsed/expanded, accessibility queries (roles/labels).
- A recorded-views fixture (`test/fixtures/views-foreach.json`, produced from a real run during the exit gate) replayed into the store to test live behaviour.
- Smoke (Playwright, one test): against `loopwork ui` with a stubbed `Service`: open the launch URL, start `loop-demo`, see the edge count rise, cancel it, see `cancelled`.

## Boundaries

- Always: render from the server's `RunView`, never recompute run state client-side; handle every `/api` error code with a message; keep status shown by text+icon, not colour only.
- Ask first: adding any dependency (layout library, state library, component library, Playwright); changing the SSE message shape (that's `ui-server`'s contract).
- Never: store the token anywhere (it's an HttpOnly cookie; the app can't see it); call `fetch` to anything but same-origin `/api`; render raw HTML from flow/event data (React escaping only; no `dangerouslySetInnerHTML`); add editing of nodes or edges (Phase 2).

## Success Criteria

- **UV-1** Selecting a run opens its stream; the graph renders every node and edge of its `Flow`, and counts update from successive views (replayed fixture).
- **UV-2** Layout is deterministic (same flow → identical positions) and respects edge direction left-to-right; nested frames lay out inside their group.
- **UV-3** Edge items/s is computed correctly from fixture views (`rate.ts` table tests), and shows nothing when idle.
- **UV-4** A frame collapses to a summary card below the zoom threshold and shows `iteration n / limit` and the budget bars with numbers; toggling is keyboard-operable.
- **UV-5** Launcher: validation errors from the server appear inline against their `path`; Start is disabled while invalid; a successful start navigates to the new run.
- **UV-6** Resume/Cancel buttons are enabled exactly per the status table; a 409 shows the server's message; Cancel requires confirmation and shows `cancelling…`.
- **UV-7** SSE drop → `reconnecting` indicator → recovery without a page reload and without duplicate or stale counts.
- **UV-8** `stalled`, `failed` (with failure message), `cancelled` and `succeeded` each render distinct, text-labelled states; an ARIA live region announces transitions.
- **UV-9** Keyboard-only: start a run, move through the run list, cancel it, and close dialogs without a pointer (component test).
- **UV-10** No colour-only encodings; axe-style checks (`jest-axe` is **not** added; use Testing Library role queries) find labelled controls and no unlabeled buttons in the main views.
- **UV-11** Rendering 10 views/s on a 200-node fixture stays under 16 ms median scripting time per update (measured in a perf test with `performance.now`; initial target, recalibrate).
- **UV-12** `pnpm --filter ui-viewer build` outputs static assets with no references to external hosts (grep), loadable under the `ui-server` CSP.
- **UV-13** Smoke test passes headless (once Playwright is approved).

## Open Questions

1. **Playwright** as a dev dependency for the single browser-level smoke test. Recommended: yes, it's the only check that the real page works under the real CSP and cookie rules. Without it UV-13 becomes a manual checklist item.
2. Layout is hand-written layered layout; revisit `elkjs` in Phase 2 when users move nodes.
