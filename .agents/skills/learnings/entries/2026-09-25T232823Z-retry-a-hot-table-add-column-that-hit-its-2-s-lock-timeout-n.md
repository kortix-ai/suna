---
recorded: 2026-09-25T23:28:23Z
incident_date: 2026-09-26
---
# Retry a hot-table ADD COLUMN that hit its 2 s lock_timeout; never raise the timeout

**Rule:** When `Apply DB migrations to prod` fails with `55P03` on a nullable
`ADD COLUMN` to a hot table, confirm the transaction rolled back (no ledger row,
no column), find the lock holder in `pg_stat_activity`, and re-run the failed
jobs. Do not raise `lock_timeout` on a single-transaction DDL migration: a long
wait queues every writer behind the `ACCESS EXCLUSIVE` request.

**Trigger surface:** a deploy-prod migration failure; writing a migration that
alters `usage_events`, `projects`, or another table the audit reconciliation
query reads.

**Incident:** 2026-09-26, v0.13.32 deploy-prod run 36199394074. Migration
`20260924221824222_connector_sync_fences_and_usage_request_id` timed out adding
`usage_events.request_id`. The holder was the audit reconciliation query
(`apps/api/src/shared/audit-reconciliation.ts`, `WITH candidates AS`): ~3M calls,
mean 0.2-0.5 s, max 25 s, `AccessShareLock` on `usage_events` and `projects`.
The whole migration rolled back; prod stayed on v0.13.31. The re-run applied all
22 migrations. No user impact.

**Enforcement:** none yet: make the migrate step retry a `55P03` on a
single-transaction migration a bounded number of times with backoff, and bound
the audit reconciliation query's own duration.
