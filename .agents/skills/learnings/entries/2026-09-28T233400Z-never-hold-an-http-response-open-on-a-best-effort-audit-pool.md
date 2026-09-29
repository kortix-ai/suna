---
recorded: 2026-09-28T23:34:00Z
incident_date: 2026-09-28
---
# Never hold an HTTP response open on a best-effort audit-pool write

**Rule:** A route that persists best-effort telemetry must return before the
write completes. Never `await` an audit-pool write on the request path: the
isolated audit pool has a fixed 2 backends and every write fans out an
`audit_events` row through `audit_prepare_event`, which holds a per-session
lock to COMMIT. Under contention the write waits tens of seconds for a backend,
so the route's p95 becomes the pool's queue depth. Detach the write
(`void persist(...).catch(log)`) and answer at once.

**Trigger surface:** Adding or editing an HTTP handler that writes
`gateway_request_logs`, `usage_events`, or anything else routed through
`auditDb()`; or triaging a route whose p95 is far above the main-pool routes
in the same window.

**Incident:** prod, 2026-09-28. `POST /internal/gateway/trace` p95 2.3 s → 44 s
(max 63 s) while `/internal/gateway/authenticate` and `/authorize` on the main
pool stayed under 1 s in the same 60 min. The handler `await`ed
`persistGatewayTrace` on the audit pool; `[audit] ingest contended` (55P03
`AUDIT_SESSION_LOCK_TIMEOUT`) and `[gateway] persistGatewayTrace failed` rose
with it. The gateway already posts the trace fire-and-forget
(`packages/llm-gateway/src/pipeline/trace.ts`), so the wait bought nothing.
Fixed by answering 200 before the write, logging a failure instead of
returning `{ok:false}` (KRTX-609). `/internal/gateway/usage` has the same
shape and was not fixed here.

**Enforcement:** `apps/api/src/llm-gateway/internal-routes.test.ts` — "answers
200 while the audit-pool write is still pending" holds the write open and
fails with a 1 s timeout if the handler waits. Run it in the `core` lane
(`pnpm --filter kortix-api test`).
