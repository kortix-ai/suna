---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# "The database went away" is backpressure, not a bad request

**When:** classifying a failed write as retryable. Connection-class failures —
57P01/57P02/57P03, 08000/08003/08006, 53300, and the driver codes that carry no
SQLSTATE at all (`CONNECTION_CLOSED`, `ECONNREFUSED`, `ECONNRESET`) — mean the
batch is still good and the database is coming back. Answer 503 with
`Retry-After`. Only errors that describe the DATA (23505, 23502, 22P05) may
answer 500, because retrying those can never work.
*Incident:* every Postgres restart made the audit ingest answer 500, which the
sandbox relay reads as "your batch is broken" and re-sends on a flat retry —
rebuilding the convoy after each restart. Prod also showed 53300 (`remaining
connection slots are reserved…`) taking out unrelated queries for 77 users on
2026-08-22. *Enforcer:* `audit-db.test.ts`.
