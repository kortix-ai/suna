// Migration: session_sandboxes_wake_cleanup_until_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index the runtime-wake fence reconcile scans with for its second
// OR arm (`metadata->>'runtimeWakeCleanupUntilAt' ~ <ISO regex> AND > <param>
// AND metadata->>'runtimeWakeLateStartStoppedAt' IS NULL`). See the sibling
// migration `20261007073000000_session_sandboxes_wake_id_index.concurrent.ts`
// for the KRTX-1308 evidence and the shape notes (`status` as the leading key;
// NOT partial on `external_id IS NOT NULL`, because the planner needs the
// whole-table null fraction of the indexed expression to estimate the OR arms
// rare enough to pick the BitmapOr). Here the range condition `> <param>` is
// the btree seek; the regex and the late-start stamp are rechecked on the
// seek's handful of rows. The two arms cannot share one btree, so the planner
// combines both indexes as a BitmapOr.
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
    create index concurrently if not exists idx_session_sandboxes_wake_cleanup_until
      on kortix.session_sandboxes (status, (metadata ->> 'runtimeWakeCleanupUntilAt'))
  `);
  // The wake query's OR arms only win the plan once the planner has
  // expression statistics for the new indexes: without them it estimates
  // `expr IS NOT NULL` from the base column (metadata is never null → ~1.0),
  // the OR clause looks dense, and the LIMIT-early cost model keeps the old
  // scan. Creating an index queues no analyze, and autovacuum's next pass on
  // this hot table could be hours away — analyze right here so the first
  // post-migration plan is already the bitmap one.
  pgm.sql('analyze kortix.session_sandboxes');
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
