// Migration: drop_duplicate_account_user_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Supabase's performance advisor flags `duplicate_index` on `basejump.account_user`:
// `idx_account_user_composite` and `idx_account_user_user_account` are identical
// indexes. Both were created by the original basejump setup, outside this
// migration system. This migration drops `idx_account_user_user_account` and keeps
// `idx_account_user_composite`, so the advisor finding clears.
//
// Neither index serves a query: app code has not read or written `basejump.*`
// since the 2026-07-06 retirement (20260706120000000_retire_basejump), no repo
// file references either index name, and the table itself is a stub awaiting the
// final drop-schema migration. Fresh installs never had the indexes
// (0000_bootstrap.sql creates only the table and its primary key), so
// `IF EXISTS` makes this a no-op there.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer. It cannot run in a transaction, hence this .concurrent.ts file
// (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the statement
// waits for transactions that began before it (learnings 2026-08-19), and that
// wait blocks nobody.
//
// One statement, one file: IF EXISTS, so a re-run after a partial failure is safe.

export const shorthands = undefined;

// mixed-version-safe: read-path only. The dropped index serves no query — no
// application code names `basejump.idx_account_user_user_account` or reads
// `basejump.account_user` (retired 2026-07-06). No ON CONFLICT clause targets it
// (it is not unique; the table's primary key is untouched), so a still-running
// older API image plans the same queries after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists basejump.idx_account_user_user_account`);
};

// Forward-only. The duplicate costs write latency on a retired stub table; it
// would be immediately re-flagged by the advisor if re-created.
export const down = false;
