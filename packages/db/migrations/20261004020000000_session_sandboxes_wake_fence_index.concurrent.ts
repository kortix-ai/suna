// Migration: session_sandboxes_wake_fence_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the partial index the runtime wake-fence reconcile scans with
// (KRTX-1304). The Supabase slow-query collector reports the statement of
// `reconcileRuntimeWakeFences` (apps/api/src/projects/session-lifecycle/
// runtime-wake-maintenance.ts) at a mean of 1540 ms over 11572 calls: it
// reads `stopped` boxes with an external id (57.7k rows in prod, prod plan:
// Seq Scan, cost 22074) and evaluates six `metadata->>'…'` extractions and
// two regexes per row to find the handful with an open wake fence — a fence
// only exists on rows whose metadata carries `runtimeWakeId` (an ambiguous
// start in flight) or `runtimeWakeCleanupUntilAt` (the late-start guard
// window after a failed wake). Prod on 2026-10-03: 502 of 57,731 such
// stopped rows carry either key, and no row carries `runtimeWakeId`.
//
// Why the predicate is `metadata ?| array[...]` and not
// `(metadata ->> 'runtimeWakeId') is not null or … is not null`: both are
// true for exactly the rows the reconcile can pick, but only the `?|` form
// gets a selective plan — Postgres cannot estimate key presence from a
// `->>'…' IS NOT NULL` clause (measured on prod: the planner estimates that
// predicate at ~100 % of rows, which pits the index against the Seq Scan on
// a ~2 % cost margin that flips with stats drift), while `?|` estimates at
// ~0.8 % of the table (508 estimated vs 495 real on a prod-shaped 66k-row
// rig) — the planner then sees a ~500-entry index and takes it by a wide,
// stable margin. The statement carries the same `?|` clause (redundant: a
// qualifying row must have `->>'runtimeWakeId' IS NOT NULL` or a
// `runtimeWakeCleanupUntilAt` matching the app's timestamp shape, and either
// implies the key exists), so the partial predicate matches the statement
// clause-for-clause in every plan mode — verified under `force_generic_plan`
// and the literal plan on PostgreSQL 15.8 (prod's version) and 16.2, and on
// prod's own planner via a hypopg hypothetical index (zero writes).
//
// `status` is the leading KEY, not a partial predicate: the app binds it as
// a query parameter, and a partial-index predicate cannot reference a
// parameter (a generic plan cannot prove `status = $1` implies any literal).
// `external_id is not null` is static in the statement, so it CAN stay a
// partial predicate.
//
// Declared in packages/db/src/schema/kortix.ts (schema contract requires
// every built index to be declared there).
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe, lock_timeout 180s (never the 2-5s plain-migration
// value: CONCURRENTLY waits on every older transaction and lock_timeout governs
// that wait), generous statement_timeout. Write impact: rows enter/leave the
// index only when `status`, `external_id`, or the two metadata keys change —
// the fence keys are stamped only around ambiguous starts, so the indexed
// slice stays at the ~500-row scale.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_wake_fences
      on kortix.session_sandboxes (status)
      where external_id is not null
        and metadata ?| array['runtimeWakeId', 'runtimeWakeCleanupUntilAt']
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
