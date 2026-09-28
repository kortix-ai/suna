---
recorded: 2026-09-28T23:50:52Z
incident_date: 2026-09-28
---
# Bound every request-path drain of the audit write queue

**Rule:** A request handler that calls `flushAuditEvents()` to observe its own
just-emitted rows must pass a budget (`flushAuditEvents({ timeoutMs })`). The
queue is off the request path by design and a contended batch is requeued, never
dropped, so a bounded read only trades freshness for availability. An unbounded
`flush()` is for shutdown and tests, where waiting is the point.

**Trigger surface:** adding or reviewing a read route over `kortix.audit_events`
(the account log, the export, the project/session log) or any code that drains
`shared/audit-queue.ts` from inside a request.

**Incident:** 2026-09-28, a 12-hour `POST …/audit/events` contention storm
(SQLSTATE 55P03 on the per-session `audit_session_sequences` row lock).
`GET /v1/accounts/:id/audit` awaited the whole global queue, waited on those
locks with no timeout, and spent its entire 25 s request budget there: p50 14.8 s,
p95 25.0 s across 19 requests, 8 x 503 `Request exceeded the 25 s server
processing deadline` and 3 x 500 `[DB ERROR 57014]` (statement timeout). The
read only needs the rows already emitted; it never needed to commit every other
session's audit rows first. KRTX-631.

**Enforcement:** `apps/api/src/shared/audit-queue.test.ts`, describe block
"AuditQueue bounded request-path flush": a bounded `flush({ timeoutMs })` is
asserted to resolve at its budget while a session lock is held, and an unbounded
`flush()` is asserted to still wait. `AUDIT_READ_FLUSH_BUDGET_MS` in
`apps/api/src/shared/audit.ts` is the shared budget the read routes pass.
