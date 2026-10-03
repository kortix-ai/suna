// Migration: drop_oauth_auth_requests_expires_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_oauth_auth_requests_expires` (btree (expires_at) on
// `kortix.oauth_authorization_requests`): the Supabase performance advisor
// reports it as unused_index (KRTX-1189), and prod's pg_stat_user_indexes
// agrees — idx_scan = 0, idx_tup_read = 0 since stats began, while the table's
// other index `idx_oauth_auth_requests_hash` is scanned. The only expires_at
// reader is the expired-request sweep (sweepExpiredAuthorizationRequests,
// apps/api/src/oauth/index.ts), whose `expires_at < X OR created_at < Y`
// predicate the planner resolves with a sequential scan of this tiny table
// (it holds only pending authorization requests, swept on a timer). Every
// kept index also costs one index write per INSERT/UPDATE on the table.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// `IF EXISTS` keeps this a no-op on any database whose baseline predates the
// index (20260826202820823_sign_in_with_kortix_oauth.sql) — a faked baseline
// can silently lack newer objects (learnings 2026-08, enum drift).
//
// mixed-version-safe: drops a plain, valid, non-unique btree that nothing
// depends on (pg_depend on the prod database: no constraint, view or policy
// references it; verified 2026-10-03), and no code names the index (a repo
// grep finds only this migration, the schema snapshot and the creating
// migration). Dropping an index never changes a query's result, only plan
// choice: old code keeps working, at worst planning the same seq scan the
// planner already chooses. The index is also removed from the Drizzle
// declaration in the same PR, so the schema contract stays consistent after
// the migration applies.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_oauth_auth_requests_expires');
};

// Re-adding an index is a `create index concurrently` migration; nothing
// needs this one back (idx_scan = 0).
export const down = false;
