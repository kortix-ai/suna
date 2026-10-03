// Migration: drop_project_sessions_origin_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two KaaB origin_ref partial indexes on kortix.project_sessions,
// reported by the Supabase performance advisor as `unused_index` (one INFO
// finding per index, both on this table; KRTX-1199):
//   - idx_project_sessions_project_origin (project_id, origin_ref)
//     WHERE origin_ref IS NOT NULL
//   - idx_project_sessions_account_origin_active (account_id, origin_ref)
//     WHERE origin_ref IS NOT NULL AND status IN the ACTIVE set
//
// Both served Kortix-as-a-Backend flows that no longer exist in the code: the
// end_user_ref session-list filter and the per-end-user concurrency-cap COUNT.
// A repo-wide grep finds no query that filters project_sessions by origin_ref,
// and the session contract tests assert origin_ref is gone from API payloads.
//
// Prod evidence (2026-10-03, pg_stat_user_indexes over the read-only Management
// SQL endpoint): idx_scan = 0 for both, with pg_stat_database.stats_reset NULL
// -- the counters have never been reset, so zero means never read. Every other
// index on the table shows six- to eight-digit scan counts. Both indexes are
// non-unique partial btrees with no constraint dependency (pg_depend), so
// nothing can depend on them.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// Fresh databases still apply the two create migrations first
// (20260727113441902_project_sessions_origin_active_index.concurrent.ts,
// 20260728082438985_project_sessions_project_origin_index.concurrent.ts), so
// both indexes exist by the time this runs; IF EXISTS keeps a re-run safe.
//
// mixed-version-safe: no code names either index and no constraint, ON
// CONFLICT clause, view or policy depends on them (non-unique partial indexes;
// verified via pg_depend on the prod database). A still-running older image
// issues the same queries -- none of them filters by origin_ref -- so it never
// plans through these indexes. If KaaB origin filtering returns, a CREATE
// INDEX CONCURRENTLY rebuild is additive and unblocked.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_project_sessions_project_origin`);
  pgm.sql(`drop index concurrently if exists kortix.idx_project_sessions_account_origin_active`);
};

// Forward-only: the rebuild is a plain CREATE INDEX CONCURRENTLY if KaaB
// origin filtering ever returns.
export const down = false;
