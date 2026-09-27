---
recorded: 2026-09-26T18:57:25Z
incident_date: 2026-09-26
---
# Never return a raw database error message in an API response body — classify the expected state and log the detail server-side

**Rule:** A route's `catch` must never put `(error as Error).message` (or any driver text) in the response. Decide whether the failure is an EXPECTED state (a capacity limit, a validation miss, a feature gap). If it is, return a typed body (`{ error: true, code, message }`) with a stable code and a plain sentence; log the full error server-side. If it is a genuine defect, return a generic 500. The typed code lets the SDK classify the state as silent to Sentry.

**Trigger surface:** Writing or reviewing any API route that catches a database error, and especially a platform-wide, time-windowed aggregate that can exceed the pool's `statement_timeout` (`packages/db/src/client.ts`, default 25s). The same applies to the web side: `packages/sdk/src/core/http/api-client.ts` must classify the typed code as silent to `onError` (Sentry).

**Incident:** 2026-09-26. `GET /v1/admin/analytics/usage` answered HTTP 500 after 25,022 ms. The platform-wide `kortix.credit_ledger` debit aggregate hit the 25s `statement_timeout` (SQLSTATE 57014). The response body carried the full `Failed query: select … from "kortix"."credit_ledger" …` SQL; the admin dashboard SDK rethrew it as an `ApiError`, so Better Stack captured the raw SQL as a frontend error (pattern `0e4ee10d…`). One occurrence, zero affected users — but every occurrence is an unactionable page that leaks schema, and the same request completed in 23.4s one run earlier, so it fails nondeterministically at the budget edge.

**Enforcement:** `apps/api/src/admin/analytics-usage-unavailable.test.ts` drives the real `analyticsApp` with a mocked `db` that rejects with a 57014 `Failed query` error and asserts the answer is a typed 503 (`code: 'analytics_unavailable'`) whose body contains no `Failed query`/`credit_ledger`/`amount_precise`. `packages/sdk/src/core/http/api-client.test.ts` asserts a typed 503 with that code does not fire `onError` (Sentry) while a genuine 503 still does. The residual cause — the aggregate approaching the budget — is NOT fixed here; the follow-up is a cheaper query or a covering index, tracked in the PR.
