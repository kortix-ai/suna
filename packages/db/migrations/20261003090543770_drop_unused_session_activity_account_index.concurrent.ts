// Migration: drop_unused_session_activity_account_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Supabase's performance advisor flags `unused_index` on `kortix.account_session_activity`:
// `idx_account_session_activity_account` (btree on account_id) has zero scans in
// `pg_stat_user_indexes.idx_scan` (prod stats: idx_scan=0, while the sibling
// `idx_account_session_activity_user` (account_id, user_id) shows 148k scans and the
// primary key 244). It is a strict prefix of the kept (account_id, user_id) index, so
// every query the planner could have used it for is served by that one.
//
// Read paths on this table (all keep their indexes): the upsert in
// apps/api/src/iam/session-gate.ts (touchActivity, ON CONFLICT on the primary key), the
// identity-reconciliation UPDATE in apps/api/src/iam/account-identity.ts
// (WHERE account_id AND user_id — served by idx_account_session_activity_user), and the
// per-session read/insert in apps/api/src/auth. The FK
// account_session_activity_account_id_fkey (ON DELETE CASCADE) keeps an index on its
// leading column: the primary key and idx_account_session_activity_user both lead with
// account_id, so cascade deletes stay index scans.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// One statement, one file: IF EXISTS, so a re-run after a partial failure is safe.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names
// `idx_account_session_activity_account`, no ON CONFLICT clause targets it (it is not
// unique; the primary key is untouched), and every (account_id)-prefix lookup stays
// covered by idx_account_session_activity_user, so a still-running older API image
// plans the same queries after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_session_activity_account`);
};

// Forward-only. The index never served a read; re-creating it would re-impose an
// index write on every session-activity upsert and be re-flagged by the advisor.
export const down = false;
