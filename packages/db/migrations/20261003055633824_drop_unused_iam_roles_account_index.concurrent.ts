// Migration: drop_unused_iam_roles_account_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops kortix.idx_iam_roles_account, the plain btree on kortix.roles(account_id)
// that prod has never used: pg_stat_user_indexes.idx_scan = 0 since the index was
// created (2026-06-28; pg_stat_database.stats_reset is NULL, server 15.8), while
// the composite idx_iam_roles_account_key (account_id, key) took 411 scans in the
// same window. Every `account_id = $1` lookup can use the composite's leading
// column, so the single-column index is redundant. Dropping it saves one index
// write per roles-row change (the Supabase unused_index advisory, KRTX-1205).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// IF EXISTS keeps a re-run after a partial failure safe: an interrupted
// CONCURRENTLY drop can leave the index behind, and the next run then drops it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. The index is not unique and backs no
// constraint (pg_constraint.conindid count = 0 on prod), so no ON CONFLICT
// clause can target it and dropping it cannot break a write. No code names a
// plain index (Postgres has no index hints). FK enforcement for
// roles.account_id -> accounts.account_id keeps index support through
// idx_iam_roles_account_key's leading column, so parent-row deletes still
// index-scan. A still-running older API image plans the same queries through
// the same or an equivalent index after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction, and CONCURRENTLY would fail inside it (MIGRATIONS.md).
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_iam_roles_account`);
};

// Forward-only: the index earned 0 scans in 3 months; re-creating it would
// re-impose its write cost for no read.
export const down = false;
