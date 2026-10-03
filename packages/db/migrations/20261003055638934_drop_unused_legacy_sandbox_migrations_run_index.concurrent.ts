// Migration: drop_unused_legacy_sandbox_migrations_run_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_legacy_sandbox_migrations_run` (btree (run_id)), reported
// by the Supabase performance advisor (lint unused_index; observed
// 2026-10-02). Prod pg_stat_user_indexes shows idx_scan = 0 over the index's
// whole lifetime while every sibling index on the table is scanned
// (status 61923, sandbox 1620, account 44, heartbeat 6). The durable runner
// that read rows by run_id was removed; the only remaining read of the table
// is the ops status group count (apps/api/src/ops/index.ts), served by
// idx_legacy_sandbox_migrations_status. An unscanned index still costs an
// index write on every INSERT/UPDATE of the table.
//
// The sibling UNIQUE partial index idx_legacy_sandbox_migrations_active_sandbox
// also reports idx_scan = 0, but it enforces "at most one live migration per
// sandbox" (scripts/verify-live-schema.test.ts pins it) and the unused_index
// lint does not flag it — unique indexes are enforced on write, not looked up.
// It stays.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: no code names the index (a git grep of
// idx_legacy_sandbox_migrations_run over the repo finds the baseline
// migration, the historical Drizzle snapshots, and the current schema
// declaration plus latest snapshot — the last two changed in this same PR),
// and nothing depends on it: it is a plain non-unique, non-partial btree, so
// no constraint, ON CONFLICT clause, view or policy can require it. An
// old image plans the same queries without it — the planner loses one
// never-used candidate and picks the same index it always picked.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_legacy_sandbox_migrations_run');
};

// Forward-only: nothing can rebuild it on purpose — the schema no longer
// declares it and no read path uses it.
export const down = false;
