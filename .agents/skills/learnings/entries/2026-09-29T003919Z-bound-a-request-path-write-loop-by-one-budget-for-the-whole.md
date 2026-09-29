---
recorded: 2026-09-29T00:39:19Z
incident_date: 2026-09-28
---
# Bound a request-path write loop by one budget for the whole request; an expected backpressure answer is never the global deadline net

**Rule:** A request-path loop that writes to the database in chunks needs ONE wall-clock budget for the whole request, not a bound per chunk. The global `requestDeadline` net (`middleware/request-deadline.ts`, 25 s) is defense-in-depth for an unbounded handler, never the answer a route with its own typed, retryable backpressure may rely on: N chunks each inside their own bound still sum past the net, and the net answers an opaque `503 [HTTPException] Request exceeded the 25s server processing deadline` at `error` instead of the route's own `503` + `Retry-After`. Set the budget so `budget + one statement_timeout < REQUEST_DEADLINE_MS`, and check it before each chunk.

**Trigger surface:** Adding or editing a chunked DB write loop in any handler under a `requestDeadline`-bounded prefix — `apps/api/src/projects/routes/*`, `apps/api/src/accounts/*`. Applies to the audit ingest route (`apps/api/src/projects/routes/project-audit.ts`), its siblings, and any new batched writer.

**Incident:** 2026-09-28, prod (`0.13.40`, commit `6ad7ec57e`), ~12:00 UTC onward. `POST /v1/projects/:id/sessions/:id/audit/events` answered the deadline net for 5566 of 5584 deadline `error` lines in 12 h (every other route: single digits). The route's 503 rate stepped up from ~0.2–1 % (2026-09-27) to 39–64 %, while request volume fell. The 503 duration histogram: ~2 s = audit-pool `lock_timeout` (55P03), ~10 s = `statement_timeout` (57014), 11–24 s = one slow chunk then a second, 25 s = the deadline net. Each chunk was bounded (12 s in-process lock wait + 10 s statement statement_timeout) and the loop was not, so two slow chunks summed past 25 s. The prod code was unchanged at the step; the audit-write contention is its own deeper cause. PR #8076 bounds the loop. It filed as KRTX-644 (`factory-key: infra:log:0ca1e5518540`).

**Enforcement:** `apps/api/src/projects/routes/project-audit-ingestion.test.ts` "a slow chunk stops the loop at the budget, so the request never reaches the 25s deadline" (fails with the budget disabled). None yet: a lint or tripwire that requires an aggregate budget on any new chunked write loop.
