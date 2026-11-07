---
recorded: 2026-11-07T06:00:59Z
incident_date: 2026-11-07
---
# Count a table's dropped column slots on every target database before a migration adds a column to it

**Rule:** Before a migration adds a column to an old table, count its column slots on each target database: `select max(attnum), count(*) filter (where attisdropped) from pg_attribute where attrelid = '<table>'::regclass and attnum > 0`. PostgreSQL never reuses a dropped column's slot, not even after `VACUUM FULL`, and a table refuses its 1,600th slot. A table near the limit is rebuilt (copy, drop, recreate, refill in one transaction) before the migration, not after it fails.

**Trigger surface:** writing an `ADD COLUMN` migration on a long-lived table (`accounts`, `account_memberships`, `project_secrets`), or a deploy whose migrate job fails with `tables can have at most 1600 columns`.

**Incident:** 2026-11-07, the dev deploy of #11857. The migration `workspace_id_account_memberships` failed on the dev database: `kortix.account_memberships` had 5 live columns and 1,595 dropped slots (`accounts` 1,148, `project_secrets` 374). Staging and prod had 0 dropped slots on every `kortix` table, so only dev was affected. The migrate job halted; the frontend and gateway rolled to the new commit while the API stayed on the old one. Fix: the table was rebuilt on dev in one transaction (2,846 rows, its view, 3 inbound foreign keys and 4 credit-table RLS policies recreated; rehearsed with ROLLBACK first; ~6 s lock). The source of the dev-only column churn is unknown.

**Enforcement:** none yet: `packages/db/scripts/migrate.ts` should print every table whose `max(attnum)` is above 1,500 before it applies a migration, and fail when a pending `ADD COLUMN` targets one.
