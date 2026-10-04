---
recorded: 2026-10-04T07:08:46Z
incident_date: 2026-10-04
---
# A batched backfill drain plans every batch against a stats-less target — never let the anti-join be a nested loop

**Rule:** When a batched `INSERT..SELECT` anti-join drains into a table the same
migration chain just created and is filling, disable the nested-loop join
strategy for each batch (`set local enable_nestloop = off` prefixed to the
batch query) or guarantee fresh statistics between batches. Do not rely on a
query-text rewrite or a new index to steer the planner: with no trustworthy
statistics every candidate plan estimates the same tiny row count, and the
planner can pick a nested loop that materializes the entire copied population
and re-scans it per candidate row — O(copied × members) per batch. Also: a
multi-statement simple query makes node-postgres return an ARRAY of results, so
`res.rowCount` is the LAST statement's — read it from
`results[results.length - 1]`, and never let a `set local` prefix turn the
drain's row-count termination check into an instant early exit.

**Trigger surface:** Writing or runtime-correcting any batched backfill
migration (`.concurrent.ts` DML passes keyed on a `NOT EXISTS` anti-join
against the filling target); reviewing one; diagnosing a migration whose
batches grow quadratically.

**Incident:** 2026-10-04, KRTX-1268. The RBAC backfill's account-membership
pass (20260819015725000_rbac_backfill_role_assignments.concurrent.ts) ran on
prod as 44 batches of 1,000 rows: mean 16,421 ms, max 45,979 ms, 722.5 s total
(pg_stat_statements) against a 120 s statement_timeout — one larger dataset
from a deploy-failing migration. Reproduced on PostgreSQL 15.8: with the target
table unanalyzed, the planner estimated the account-scope probe at ~1 row,
materialized the whole copied population (`Rows Removed by Join Filter:
199,990,000` for 20k members), and batches grew to 18 s; a first fix attempt
(rewriting the probe's `is null` filters to the identity index's COALESCE
expressions) PASSED standalone tests polluted by leftover statistics and still
went catastrophic in the runner's fresh-database session — the integration test
caught it. With `set local enable_nestloop = off` prefixed per batch, the same
run completes in ~6 s (runner + 20k-member drain) with byte-identical rows.
Delivered as a checksum-guarded entry in
`packages/db/scripts/migration-runtime-overrides.ts` because the migration is
immutable and already applied.

**Enforcement:** `packages/db/scripts/rbac-backfill-probe-override.integration.test.ts`
(db-suites lane) applies the chain up to the backfill, seeds 20,000 synthetic
members, runs the overridden migration through the real runner, asserts exact
row counts/source split and a time bound that the quadratic plan cannot meet;
`migration-runtime-overrides.test.ts` pins the override text, checksum
fail-closed behavior, and that the materialized copy is loadable JavaScript.
