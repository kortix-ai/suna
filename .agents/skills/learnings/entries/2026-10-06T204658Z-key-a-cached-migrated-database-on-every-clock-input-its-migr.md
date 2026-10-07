---
recorded: 2026-10-06T20:46:58Z
incident_date: 2026-10-05
---
# Key a cached migrated database on every clock input its migrations read

**Rule:** A migrated database cached across test runs must be keyed on every clock input its migrations read. The audit-partition migration pre-creates weekly partitions from `current_date` at apply time, so a template built last week serves partitions that end before this week's horizon. Include the build week in `migrationTemplateHash`, and derive a DB test's expectation from the live catalog instead of asserting a number that only holds in the migration's own week.

**Trigger surface:** adding or editing a migration that reads `now()`, `current_date` or any other clock state; touching `tests/src/core/db-suites.ts` template caching; writing a DB suite that asserts a fixed count about migration-created objects (partitions, index counts, retention windows).

**Incident:** 2026-10-01, the `audit_events` partitioning migration pre-created weekly partitions through its apply week + 8. The per-suite template cache keyed on migration content alone kept serving databases migrated on the apply week. At the first Monday 00:00 UTC after the merge (2026-10-05) the `audit-partition-worker.integration.test.ts` no-op assertion failed with `created: 1` on every fresh per-suite database — every developer and the scheduled daily `Tests` lane — and `audit-events-partitioned.integration.test.ts` failed its partition-coverage assertions once a template was about two weeks old. Eight worker attempts over two days before the fix.

**Enforcement:** `tests/unit/db-suites.test.ts` ("rebuilds the template when the ISO week rolls over" — red without the week key; that pair is the only direct guard on the hash) and `apps/api/src/shared/audit-partition-worker.integration.test.ts` (the horizon expectation is read from the live catalog and a rollover is simulated on any UTC day by dropping the newest horizon partition — these pass at any template age, so they pin the worker's idempotent recreate and keep the suite green after a Monday, but they do NOT fail when the week key is reverted; the stale-template time bomb they prevent is `packages/db/scripts/audit-events-partitioned.integration.test.ts`'s coverage assertions once a template is about two weeks old).
