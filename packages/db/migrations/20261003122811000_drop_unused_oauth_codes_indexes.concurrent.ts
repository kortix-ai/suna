// Migration: drop_unused_oauth_codes_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two kortix.oauth_authorization_codes indexes the Supabase
// performance advisor reports as unused (lint unused_index, observed
// 2026-10-02, KRTX-1188):
//
//   idx_oauth_codes_client   btree (client_id)    idx_scan = 0
//   idx_oauth_codes_expires  btree (expires_at)   idx_scan = 0
//
// pg_stat_user_indexes shows idx_scan = idx_tup_read = idx_tup_fetch = 0 for
// every index on the table, and pg_stat_database.stats_reset IS NULL — the
// counters were never reset, so the indexes have never served a scan. The
// table holds one row (8 KB); each dropped index still costs an index write
// on every issued authorization code.
//
// No read path loses coverage:
//   - the only client_id-filtered read is the code-exchange lookup
//     (apps/api/src/oauth/index.ts:816, WHERE code = ? AND client_id = ?);
//     the unique idx_oauth_codes_code serves it (code is unique, so one row),
//     and client_id is a secondary filter on that row;
//   - expires_at has no reader: expiry is checked in code after the row is
//     fetched (apps/api/src/oauth/index.ts:822), and no sweeper deletes by it.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// Two statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They stay
// separate pgm.sql() calls: a multi-statement string is an implicit
// transaction and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names either index
// and no constraint, view, policy or ON CONFLICT clause depends on them (both
// are plain non-unique indexes; the only unique index on the table,
// idx_oauth_codes_code, stays). Dropping a non-unique index removes a
// redundant access path, never a correctness constraint, so a still-running
// older API image plans the same queries after the drop: the code-exchange
// lookup keeps using idx_oauth_codes_code, and the identity-reconcile DELETE
// (apps/api/src/iam/account-identity.ts:357) and the auth-user-delete trigger
// DELETE (20260929225114414) already seq-scan. The client_id FK cascade then
// seq-scans a table that holds one row; the same client FKs on
// kortix.oauth_consents and kortix.oauth_authorization_requests already run
// unindexed (the advisor files that class separately as
// unindexed_foreign_keys).
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_oauth_codes_client`);
  pgm.sql(`drop index concurrently if exists kortix.idx_oauth_codes_expires`);
};

// Forward-only. Re-creating unread indexes would re-impose their write cost.
export const down = false;
