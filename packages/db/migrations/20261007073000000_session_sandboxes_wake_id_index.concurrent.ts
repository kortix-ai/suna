// Migration: session_sandboxes_wake_id_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index the runtime-wake fence reconcile scans with for its first
// OR arm (`metadata->>'runtimeWakeId' IS NOT NULL AND <wake-lease open>`). The
// Supabase slow-query collector (KRTX-1308) reports the statement of
// `reconcileRuntimeWakeFences` (apps/api/src/projects/session-lifecycle/
// runtime-wake-maintenance.ts) at a mean of 3964 ms over 1075 calls while
// returning ~0.4 rows per call in total: the candidate set is nearly always
// empty, yet every maintenance pass scanned every `stopped` row with an
// external id (~45.6k) and evaluated the jsonb predicates on it. This index
// lets the planner jump straight to the rows that carry a wake id at all; the
// lease conditions and the third conjunct are rechecked on that handful.
//
// Declared in packages/db/src/schema/kortix.ts (schema contract requires every
// built index to be declared there). Shape notes:
//   - `status` is the leading KEY, not a partial-index predicate: the app
//     binds it as a query parameter, and a generic plan cannot prove
//     `status = $1` implies `status = 'stopped'`, so a partial index on the
//     status would fall out of the plan after the first few executions.
//   - NOT partial on `external_id IS NOT NULL`: this query has no ORDER BY,
//     so the planner must estimate that the OR arms are rare to prefer the
//     BitmapOr over a scan that "finds 100 rows soon". A partial index's
//     statistics describe only its own predicate's rows and are not used for
//     a global estimate, so `expr IS NOT NULL` would fall back to the base
//     column (metadata is never null → ~1.0) and the old scan would win.
//     Measured on a prod-shaped PostgreSQL 15.19 rig: partial → Seq Scan
//     (91 ms); non-partial → BitmapOr (0.2 ms) under the app's own
//     parameterized driver.
//   - The OR arm over `metadata->>'runtimeWakeCleanupUntilAt'` cannot share
//     this btree (an unbounded second arm cannot seek past the first key), so
//     the sibling migration builds it its own index; the planner combines the
//     two as a BitmapOr.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe, lock_timeout 180s (never the 2-5s plain-migration
// value: CONCURRENTLY waits on every older transaction and lock_timeout governs
// that wait), generous statement_timeout.

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
    create index concurrently if not exists idx_session_sandboxes_wake_id
      on kortix.session_sandboxes (status, (metadata ->> 'runtimeWakeId'))
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
