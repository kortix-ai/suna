// Migration: drop_unused_connector_project_policies_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_connector_project_policies_project` (btree (project_id) on
// kortix.connector_project_policies), which the Supabase performance advisor
// reports as unused_index (INFO). Prod pg_stat_user_indexes shows idx_scan = 0
// with stats_reset never set, and the table holds ~10 rows / 80 kB total
// (2026-10-03 read via the Management API read-only SQL endpoint), so the
// planner seq-scans the table on every read and the index can never earn a
// scan at this size. It only costs an index write on each INSERT/DELETE. Built
// by the baseline as idx_executor_project_policies_project and renamed by the
// connector physical cutover (20260806140107656).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique btree index. No query names the
// index (repo-wide grep: only the kortix.ts declaration removed in the same PR
// and the rename map of 20260806140107656), and pg_depend on prod shows no
// constraint, view or policy depending on it (2026-10-03). A missing index
// changes plans, never results, so a still-running older image tolerates it.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_connector_project_policies_project`);
};

// Forward-only: a new project_id index is a plain CREATE INDEX CONCURRENTLY
// if the table ever grows past seq-scan size.
export const down = false;
