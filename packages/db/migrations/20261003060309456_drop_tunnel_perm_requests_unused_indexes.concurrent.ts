// Migration: drop_tunnel_perm_requests_unused_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops all three secondary indexes on kortix.tunnel_permission_requests --
// idx_tunnel_perm_requests_tunnel (tunnel_id), idx_tunnel_perm_requests_account
// (account_id) and idx_tunnel_perm_requests_status (status) -- exactly the set
// the Supabase performance advisor reports as unused_index on that table
// (KRTX-1211; idx_scan = 0 on every one, verified read-only via
// pg_stat_user_indexes on prod, the primary key included). Each index costs an
// index write on every INSERT/UPDATE for nothing: no application code reads or
// writes the table at all (a search of apps/, packages/ and infra/ finds zero
// references outside the Drizzle schema and the migrations).
//
// Three statements, one file: all three indexes serve the same finding on the
// same table, and DROP INDEX CONCURRENTLY holds only ShareUpdateExclusive --
// the three drops queue on it but block no reader or writer.
//
// The tunnel_id index is (was) the FK's covering index; the FK itself is
// dropped by the preceding migration. Keeping either would only re-file the
// other lint (unindexed_foreign_keys / unused_index) on the same table.
//
// mixed-version-safe: Postgres never references an index by name, no code
// references the table (see above), and no view, policy or constraint depends
// on these plain non-unique btrees (verified via pg_views, pg_policies and
// pg_depend on the prod database, read-only, 2026-10-03). A still-running
// older image plans the same queries -- it runs none against this table --
// through seq scans of 27 rows.
//
// The Kortix baseline never leaves the table without these indexes for long:
// it creates them, the preceding migration drops the FK, this file drops the
// indexes, so a fresh/self-host database reaches the same primary-key-only end
// state. IF EXISTS makes a re-run safe.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_tunnel_perm_requests_tunnel
  `);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_tunnel_perm_requests_account
  `);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_tunnel_perm_requests_status
  `);
};

// Forward-only: if a reader ever returns, recreate each index with
// `create index concurrently if not exists <same name> on kortix.tunnel_permission_requests
// using btree (<same column>)` and re-add the FK (see the preceding migration).
export const down = false;
