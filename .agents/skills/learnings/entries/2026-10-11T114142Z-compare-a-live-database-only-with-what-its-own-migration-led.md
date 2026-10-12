---
recorded: 2026-10-11T11:41:42Z
incident_date: 2026-10-11
---
# Compare a live database only with what its own migration ledger records as applied

**Rule:** Build the canonical database for a live-schema check only from the migrations that live ledger records as applied. Exclude runtime-created objects (weekly `audit_events_pYYYYMMDD` partitions) by an explicit, narrow name rule.

**Trigger surface:** Editing `db-drift.yml`, `verify-live-schema.ts` or `schema-signature.sql`, or adding a runtime job that creates tables.

**Incident:** 2026-10-11. `DB Drift Sentinel` was red on every run. Job `prod-presence` failed whenever dev held an unreleased migration (41 pending, for example a column added by a notification migration). Job `Schema drift (dev)` failed on every run since 2026-10-06 with 65 extra live lines, all from one runtime-created audit partition that a fresh build lacks.

**Enforcement:** `packages/db/scripts/prune-unapplied-migrations.ts` runs in `db-drift.yml` before the canonical build (unit test `unappliedMigrationFiles`). `schema-signature.integration.test.ts` pins the partition exclusion.
