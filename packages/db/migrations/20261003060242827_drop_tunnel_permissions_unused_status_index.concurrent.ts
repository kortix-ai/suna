// Migration: drop_tunnel_permissions_unused_status_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_tunnel_permissions_status`, reported by the Supabase
// performance advisor as `unused_index` on `kortix.tunnel_permissions`
// (KRTX-1212): the planner has never picked it. Read from prod on 2026-10-03
// (Management API read-only): `pg_stat_user_indexes` shows `idx_scan = 0`,
// `idx_tup_read = 0`, `idx_tup_fetch = 0` since stats began, and the advisor
// lint confirms it. Every extra index costs an index write on each
// tunnel_permissions INSERT/UPDATE for nothing.
//
// Why the planner never uses it: the only two queries that filter on
// `status` also filter on `tunnel_id` first (apps/api/src/tunnel/index.ts,
// apps/api/src/tunnel/core/permission-checker.ts), so the planner reads
// `idx_tunnel_permissions_tunnel` (24,485 scans) or
// `idx_tunnel_permissions_capability` (321 scans) and filters the rows it
// returns; a single-column btree on a low-cardinality status enum over a
// 1,145-row / 216 kB table loses every time. Those queries keep their plans.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: the index serves no query and no object depends on it.
// Nothing executable names it: a grep of `idx_tunnel_permissions_status` over
// the repo finds only the schema declaration removed in this change, the
// immutable baseline migration that creates the index, drizzle's historical
// snapshots (generator bookkeeping, never applied), and this file. It backs
// no constraint (pg_constraint conindid = 0) and has no dependency beyond
// its own table (pg_depend shows only the auto dependency; it is non-unique
// and valid). Postgres never references an index by name in a plan, and DROP
// INDEX invalidates cached plans, so a still-running older image plans the
// same status-filtering queries through the kept tunnel/capability indexes
// and cannot fail from this drop.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_tunnel_permissions_status`);
};

// Forward-only: an unused index is not worth a rebuild migration; re-add it
// only if a status-only scan ever shows up in the Supabase advisor or the
// slow-query ledger again.
export const down = false;
