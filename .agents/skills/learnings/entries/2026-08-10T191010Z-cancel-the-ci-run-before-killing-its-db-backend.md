---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# Cancel the CI run before killing its DB backend

**When:** a deploy's migration step is wedging prod and you terminate it.
The migrate step (and `withMigrationDeadlockRetry`) retries: killing only the
Postgres backend re-locks the table minutes later. Order: cancel the workflow
run, then `pg_terminate_backend`, then verify no reconnect.
*Incident:* v0.12.7 — first kill was undone by a retry; prod degraded a second
time before the run was cancelled.
