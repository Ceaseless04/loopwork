# Spec: ui-server (`@loopwork/ui-server`)

Depends on: `run-service`. Inherits [repo-wide conventions](CAPABILITY-MAP.md#repo-wide-conventions-every-module-spec-inherits-these).

## Objective

A local HTTP server that makes the GUI **interactive**: it lets a browser window list and start flows, watch runs
live, and resume or cancel them, by calling `run-service`. It owns the HTTP/SSE contract that `ui-viewer` codes
against, and the security model for a write-capable localhost service.

## Tech Stack

TypeScript, `node:http`, `node:crypto`. No framework.

## Commands

```
pnpm --filter @loopwork/ui-server test
loopwork ui --no-open            # after the cli module exists: run the server by hand
```

## Project Structure

```
packages/ui-server/
  src/server.ts        startUiServer(opts): Promise<UiServer>
  src/routes.ts        route table: method + pattern → handler
  src/auth.ts          token, session cookie, Host/Origin/CSRF checks
  src/sse.ts           SSE writer with heartbeat, backpressure, Last-Event-ID
  src/static.ts        serves the built viewer from `staticDir` with SPA fallback
  src/idle.ts          idle-shutdown timer
  test/
```

## Contract

```ts
startUiServer(opts: {
  service: Service; staticDir?: string;       // built ui-viewer; absent = API only
  host?: '127.0.0.1';                         // the only accepted value
  port?: number;                              // default 0 = random free port
  idleTimeoutMs?: number;                     // default 30 min; 0 = never. Reset by any request or open SSE stream
}): Promise<UiServer>
type UiServer = { url: string /* http://127.0.0.1:PORT/?t=TOKEN */; token: string; port: number; close(): Promise<void>; onIdleExit: Promise<void> }
```

### HTTP API (JSON; all `/api/*` need a valid session)

| Method + path | Calls | Response |
|---|---|---|
| `GET /api/health` | | `{ ok: true, version }` |
| `GET /api/flows` | `listFlows` | `FlowFile[]` |
| `GET /api/flows/:name` | `readFlow` | the flow JSON |
| `POST /api/validate` `{flow}` | `validateFlow` | `ValidationReport` |
| `POST /api/runs` `{flow \| flowName, input?}` | `startRun(createdBy:'ui')` | `201 {runId}` |
| `GET /api/runs?status&limit&before` | `listRuns` | `RunSummary[]` |
| `GET /api/runs/:id` | `inspectRun` | `RunView` |
| `GET /api/runs/:id/stream` | `watchRun` | **SSE**: `event: view`, `id: <lastSeq>`, `data: <RunView JSON>`; ≤ 10 per second |
| `GET /api/runs/:id/events?from&limit&types` | `readEvents` | `{ events, nextSeq }` |
| `POST /api/runs/:id/resume` | `resumeRun` | `202 {runId, queued:true}` |
| `POST /api/runs/:id/cancel` | `cancelRun` | `202 {runId, state}` |
| `GET /api/runs/stream` | `listRuns` polled at 1 s, diffed | **SSE**: `event: runs`, the changed `RunSummary[]` |

Error body: `{ error: { code, message, details? } }`. Status mapping: `E_VALIDATION`/`E_BAD_REQUEST`/`E_UNKNOWN_FN` → 400,
`E_NOT_FOUND` → 404, `E_NOT_RESUMABLE`/`E_NOT_CANCELLABLE` → 409, `E_DB_UNREACHABLE` → 503, `E_CONFIG` → 500, else 500.
Request bodies are capped at 5 MB; `Content-Type` must be `application/json` on every `POST`.

The viewer never receives raw per-item events by default: the stream carries **coalesced `RunView`s**. Raw events
are pulled in pages only for drill-down.

### Security model (write-capable localhost service)

1. Binds `127.0.0.1` only. A `host` option with any other value throws.
2. A random 32-byte token (base64url) is generated per server start and embedded in the launch URL (`/?t=…`).
3. `GET /` or any static path with a correct `?t=` sets cookie `lw_session=<token>; HttpOnly; SameSite=Strict; Path=/` and redirects to the same path **without** the token. `/api/*` requires that cookie (compared in constant time). The token is never accepted in an API query string.
4. **DNS-rebinding defence:** every request's `Host` header must be exactly `127.0.0.1:<port>` or `localhost:<port>`.
5. **CSRF:** every `POST` must have an `Origin` header equal to `http://127.0.0.1:<port>` or `http://localhost:<port>`, plus the JSON content type. No CORS headers are ever sent.
6. Static files: path-normalized inside `staticDir`; `..` rejected; `Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
7. The token is never logged; `UiServer.url` is printed only on stdout of `loopwork ui --print-url`.

### SSE rules

`: keepalive` comment every 15 s; `Last-Event-ID` resumes from a seq (a fresh full `view` is always sent first, so
this is an optimisation, not a correctness need); a client whose socket buffer stays full for 5 s is dropped
(it reconnects); streams end after the terminal view; aborting the request aborts the underlying `watchRun`.

## Code Style

```ts
route('POST', '/api/runs/:id/cancel', async ({ params, svc }) => {
  const r = await svc.cancelRun(params.id);
  return json(202, r);
});
```
Handlers are small and return `{ status, body }`; auth, error mapping and logging live in the wrapper.

## Testing Strategy

Tests start the real server on port 0 with a **fake `Service`** (in-memory, scriptable views) and use `fetch`/`EventSource`-style readers
from `node:http`. Security tests are table-driven. One `*.pg.test.ts` wires the real `run-service` for a start → stream → terminal flow.

## Boundaries

- Always: every route goes through the auth wrapper; every error goes through the status mapper; close SSE streams on shutdown.
- Ask first: adding a route that writes; relaxing any header or cookie flag; serving anything outside `staticDir`.
- Never: bind a non-loopback address; enable CORS; accept the token anywhere but the first `GET` query; return stack traces to the client; call anything but `Service`.

## Success Criteria

- **US-1** `startUiServer` listens on `127.0.0.1` on a random port; passing another host throws; `close()` ends open SSE streams and resolves.
- **US-2** Without the cookie, `/api/*` returns 401; a wrong token returns 401; the right `?t=` sets the cookie with `HttpOnly; SameSite=Strict` and redirects without the token.
- **US-3** A request with `Host: evil.example` or `Host: 127.0.0.1.evil.example` is rejected 421/403 even with a valid cookie.
- **US-4** A `POST` with a foreign or missing `Origin`, or a non-JSON content type, is rejected 403/415 and calls nothing on the service (spy).
- **US-5** `POST /api/runs`, `/resume`, `/cancel` each call the matching `Service` method once and map every `ServiceError` code to the documented status.
- **US-6** `GET /api/runs/:id/stream` sends a full `view` first, then ≤ 10 per second, with non-decreasing `lastSeq`, and ends after a terminal view.
- **US-7** Dropping the client connection aborts the `watchRun` iterator (no leaked subscription; asserted via spy).
- **US-8** A client that never reads is disconnected within ~5 s and does not stall other streams.
- **US-9** Static serving: `..`, encoded `..%2f`, absolute paths and symlink escapes return 404; unknown paths fall back to `index.html` (SPA); security headers are present on every response.
- **US-10** Bodies over 5 MB return 413; malformed JSON returns 400 `E_BAD_REQUEST`.
- **US-11** With `idleTimeoutMs: 200` and no traffic, `onIdleExit` resolves and the server closes; an open SSE stream or a request resets the timer.
- **US-12** No response or log line contains the token after the first redirect (grep the captured logs).

## Open Questions

None blocking. HTTPS is not used (loopback only); revisit if a remote-access mode is ever added, which would be a new ADR.
