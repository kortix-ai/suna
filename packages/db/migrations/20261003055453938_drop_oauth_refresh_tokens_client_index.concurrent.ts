// Migration: drop_oauth_refresh_tokens_client_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_oauth_refresh_tokens_client` (btree (client_id)) on
// `kortix.oauth_refresh_tokens`: the Supabase performance advisor reports it
// unused (lint unused_index, INFO, KRTX-1191) and pg_stat_user_indexes
// .idx_scan is 0 on prod (2026-10-03, stats never reset). Every extra index
// costs an index write on each oauth_refresh_tokens INSERT/UPDATE, for
// nothing.
//
// The client_id reads over this table (apps/api/src/oauth/index.ts:775, 859,
// 944, 1104) were served without this index on every deployed environment:
// the unique token-hash lookup picks the row (line 859) and the other paths
// scan the ~26-row table. If a future workload makes a client_id index pay
// for itself, `create index concurrently` rebuilds it in one migration.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops only an index no query plan ever used (idx_scan=0
// on prod since its stats began). Postgres never references an index by name,
// and the index is non-unique: it backs no constraint, ON CONFLICT clause,
// view or policy (verified via pg_depend, pg_views and pg_policies on the
// prod database). A still-running older image plans the same queries through
// the same non-index paths it always used.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_oauth_refresh_tokens_client`);
};

// Forward-only: a single `create index concurrently` rebuilds this index
// whenever a future workload needs it.
export const down = false;
