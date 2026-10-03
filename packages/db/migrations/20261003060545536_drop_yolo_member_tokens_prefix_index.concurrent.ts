// Migration: drop_yolo_member_tokens_prefix_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_yolo_member_tokens_prefix` on `kortix.yolo_member_tokens`:
// a partial btree on (token_prefix) WHERE revoked_at IS NULL that has never
// been scanned. Reported by the Supabase performance advisor (lint
// unused_index, KRTX-1215). Every index costs an index write on each
// INSERT/UPDATE of the token lifecycle for zero reads.
//
// Evidence (prod, read-only Management API query, 2026-10-03):
//   pg_stat_user_indexes: idx_scan = 0, idx_tup_read = 0 (since stats began),
//   while the PK scans 52x and idx_yolo_member_tokens_account 11x.
//   pg_depend: no object depends on the index (no constraint, view or policy).
//   Table is 16 kB: a sequential scan is cheaper than any index probe anyway.
//
// The one prefix-shaped read in the code (`WHERE token_prefix = <param> AND
// revoked_at IS NULL`, apps/api/src/billing/services/yolo-tokens.ts) runs
// against this tiny table, where the planner has always preferred the PK or a
// sequential scan -- that is exactly why the index never reached idx_scan > 0.
// The planner does not know an index by name, so removing it cannot break a
// plan that was never chosen.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a non-unique, non-constraint partial index. No
// code names it (git grep over the repo finds only the schema declaration,
// the drizzle snapshots and the baseline), no ON CONFLICT clause infers
// against it (the token upsert targets the (user_id, account_id) primary
// key), and pg_depend on the prod database shows zero dependents. A
// still-running older image plans the same queries through the PK or a
// sequential scan, as it always did, so the drop cannot change a query
// plan's availability. Fresh/self-host databases build the index in the
// baseline and drop it here, so the schema contract holds everywhere.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_yolo_member_tokens_prefix`);
};

// Forward-only: the planner never chose this index; nothing recreates it.
export const down = false;
