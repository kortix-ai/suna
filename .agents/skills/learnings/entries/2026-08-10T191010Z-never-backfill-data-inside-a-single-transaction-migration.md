---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# Never backfill data inside a single-transaction migration

**When:** writing any `.sql` migration under `packages/db/migrations/`.
A plain `.sql` migration runs in ONE transaction, so its `ALTER TABLE`s hold
ACCESS EXCLUSIVE until COMMIT — top-level `UPDATE`/`INSERT INTO`/`DELETE
FROM`/data-modifying `WITH` in the same file turns milliseconds of lock into the
full backfill duration, blocking every writer on the table. Write data moves as
batched, incrementally-committed `.concurrent.ts` passes or a supervised
out-of-band runbook (short-tx DDL → triggers → chunked updates → CONCURRENTLY
indexes → ledger rows).
*Incident:* v0.12.7 promote — `centralized_audit_v2` rewrote 30.5M rows of
`audit_events` under lock; prod down ~30 min.
*Enforcer:* `lint-migrations.ts` backfill-DML guard (`-- backfill-safe:`
sign-off escape hatch; `backfill-grandfathered-migrations.json` snapshot).
