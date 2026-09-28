---
recorded: 2026-09-26T01:42:44Z
incident_date: 2026-09-25
---
# Never return a raw database error message to a client

**Rule:** A query failure must be logged server-side with its Postgres fields and mapped to a stable typed error body. Never put `(error as Error).message` — or any postgres.js error — into an HTTP response. postgres.js embeds the whole statement and every bound parameter value after `\nparams:`, so the message is a data leak, not a diagnosis.

**Trigger surface:** Any `catch` around a DB write that builds an HTTP error body, and any `4xx/5xx` body the web SDK turns into an `ApiError`.

**Incident:** 2026-09-25 prod `POST /v1/projects/:id/sessions` returned a failed `insert into kortix.project_sessions` as `500 { error: "<full SQL> params: <all bound values>" }`. The web SDK threw it as an `ApiError` and Better Stack captured pattern `9aecd4f8…` carrying attachment filenames and model config. 1 occurrence, 0 users. Nothing logged the actual pg cause, so the root cause is unrecoverable from the retained logs. Fixed by `resolveSessionInsertFailure` in `apps/api/src/projects/lib/sessions.ts` (logs `code`/`constraint`/`table`/`column`/`detail` + statement with params stripped, returns `500 SESSION_CREATE_FAILED` or `409 session_already_exists`).

**Enforcement:** `apps/api/src/projects/lib/sessions-insert-failure.test.ts` fails if the mapped body contains the SQL or a bound value, and fails to import if the raw-message path returns.
