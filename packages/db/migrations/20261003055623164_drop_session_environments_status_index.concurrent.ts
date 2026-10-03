// Migration: drop_session_environments_status_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_session_environments_status` on `kortix.session_environments`:
// the Supabase performance advisor reports it as `unused_index`, and the prod
// catalog confirms it — `pg_stat_user_indexes.idx_scan` is 0 for this index
// (the table's other indexes have 1-9 scans). Every extra index costs an index
// write on each INSERT/UPDATE, for nothing: every query in the codebase reaches
// a `session_environments` row by `session_id` (the primary key) or filters by
// `external_id`; the one `status` predicate (apps/api/src/platform/services/
// session-environment.ts) is a residual filter on the single row already
// located by its `session_id` equality.
//
// `DROP INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// Fresh/self-host databases build the index with
// 20260827163618062_session_environments and drop it right after — `IF EXISTS`
// makes this a no-op if a future baseline stops creating it.
//
// mixed-version-safe: no code names the index (a git grep of the name over the
// repo finds only its declaration and the migration that built it) and no
// constraint, view or policy depends on it (pg_depend on the prod database
// shows only the index's own auto dependency on its table). Postgres never
// references an index by name in a plan, and idx_scan = 0 proves no plan has
// ever used this one, so a still-running older image cannot be relying on it.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_session_environments_status`);
};

// Forward-only: nothing reads this index; a future need re-creates it
// CONCURRENTLY through the same escape hatch.
export const down = false;
