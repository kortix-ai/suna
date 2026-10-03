// Migration: session_sandboxes_wake_fence_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Partial index over the runtime-wake candidate rows of kortix.session_sandboxes.
// `reconcileRuntimeWakeFences` (apps/api/src/projects/session-lifecycle/
// runtime-wake-maintenance.ts) scans the table on every maintenance pass for
// stopped boxes with an open wake fence; only ~600 of 65450 prod rows carry
// either key, but without an index every pass read all 65k rows and evaluated
// six jsonb extractions per row (mean 1540 ms over 11572 calls on the
// pre-KRTX-267 statement shape, 3943 ms over 1278 calls on the current one,
// pg_stat_statements 2026-10-03 — KRTX-1304).
//
// The predicate is exactly the OR block the query itself carries, minus the
// parameterized pieces (`status = $1`, the two lease `<= $now` comparisons)
// that an index predicate cannot hold: with them, generic plans could not
// prove the implication and would fall back to the seq scan. The planner
// proves `status = 'stopped' AND external_id IS NOT NULL AND (wake OR cleanup
// block)` implies this predicate by exact match on each arm, under custom and
// generic plans, for both the current and the legacy statement shape. The
// paired statistics migration (20261003182500001) is what makes the planner
// CHOOSE the index: without real expression counts the LIMIT-adjusted seq scan
// looks cheaper than any index path.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a
// failed build must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_wake_fence
      on kortix.session_sandboxes using btree (external_id)
      where external_id is not null
        and (
          metadata->>'runtimeWakeId' is not null
          or metadata->>'runtimeWakeCleanupUntilAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
        )
  `);
};

export const down = false;
