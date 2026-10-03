// Migration: drop_unused_oauth_access_token_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two kortix.oauth_access_tokens indexes that no read path has ever
// used. Prod evidence (2026-10-03, pg_stat_user_indexes, stats never reset,
// PG 15.8 persistent stats):
//
//   idx_oauth_access_tokens_client (client_id)  idx_scan = 0
//   idx_oauth_access_tokens_user   (user_id)    idx_scan = 0
//
// The table holds 29 rows and 2 clients; token lookups run through the kept
// unique idx_oauth_access_token_hash. The two dropped indexes only cost an
// index write on every token insert/update (Supabase advisor: unused_index,
// INFO). The token-hash unique index is the only ON CONFLICT target and the
// only FK-lookup column (oauth_refresh_tokens.access_token_id -> id), and both
// stay.
//
// Every read keeps working: the client_id anti-join in the OAuth sweeper and
// the user/client revoke queries seq-scan a tiny table instead, and a
// still-running older API image plans the same queries after the drop — no
// query names an index. If the OAuth feature ever grows to where a seq scan
// costs real time, re-add the needed index with one concurrent migration.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// Two statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They stay
// separate pgm.sql() calls: a multi-statement string is an implicit transaction
// and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
// mixed-version-safe: non-unique indexes; no application code names them and
// no ON CONFLICT clause targets them (the only conflict targets are
// oauth_access_tokens_pkey and idx_oauth_access_token_hash, both kept). The
// client_id and user_id reads (oauth sweeper, token revocation, identity
// reconciliation) fall back to a seq scan of a 29-row table, so a
// still-running older API image plans the same queries after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_oauth_access_tokens_client`);
  pgm.sql(`drop index concurrently if exists kortix.idx_oauth_access_tokens_user`);
};

// Forward-only. Re-creating unused indexes would re-impose their write cost.
// If a read path later needs one, add it with its own concurrent migration.
export const down = false;
