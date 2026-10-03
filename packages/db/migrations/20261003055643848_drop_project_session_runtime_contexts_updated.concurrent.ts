// Migration: drop_project_session_runtime_contexts_updated  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_project_session_runtime_contexts_updated` (btree on
// updated_at), reported by the Supabase performance advisor (lint
// unused_index). Every extra index costs an index write on each INSERT with
// no reader to pay for it.
//
// The table's only access patterns in this repo are the session_id primary-key
// lookup (`loadSessionRuntimeContext` in apps/api/src/projects/lib/session-runtime-context.ts)
// and the INSERT at session create; no query filters or orders by updated_at.
// Prod's pg_stat_user_indexes records idx_scan = 0 for this index over its
// whole life (table created 2026-07-12, stats never reset), 3,693 rows, 96 kB.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: no code names the index (a git grep of the name over
// the repo finds only this file and the 20260712160000000 migration that
// created it) and no constraint, ON CONFLICT clause, view or policy depends
// on it (pg_depend on the prod database is empty; the index is plain and
// non-unique). A still-running older image plans the same queries without it:
// 0 scans prove the planner never selected it, so the drop cannot change a
// query plan's availability.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_project_session_runtime_contexts_updated`);
};

// Forward-only: nothing reads the index. Recreate it only if a query starts
// filtering by updated_at (declare it in kortix.ts and build CONCURRENTLY).
export const down = false;
