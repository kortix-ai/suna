// Migration: drop_duplicate_account_memberships_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops kortix.idx_account_members_user_account, the exact duplicate of the
// table's primary-key index account_members_pkey (both on (user_id, account_id)
// btree, unique). It has been redundant since the 20260621094136410 baseline;
// the Supabase performance advisor reports it as duplicate_index.
//
// Every read and every conflict target the table serves is covered by the
// primary key:
//   - identity reads by (user_id, account_id): getAccountMembership,
//     on-behalf-of's member EXISTS check, sso-sync's membership sync;
//   - user-only reads: the PK leads with user_id (leftmost prefix);
//   - account-only reads keep idx_account_members_account_id;
//   - every writer conflicts on the PK: INSERT ... ON CONFLICT (user_id,
//     account_id) (invite accept, member add, seat management).
// A still-running older API image plans the same statements without it.
//
// The preceding migration (20261003115140660_account_memberships_replica_
// identity_pk.sql) re-points the table's REPLICA IDENTITY to the surviving PK
// first, so no environment is left with an identity flag that has no index
// behind it when this index goes away.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer, and it only unlinks files (no heap rewrite). It cannot run
// in a transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// One statement, one file, IF EXISTS: a re-run after a partial failure is safe
// and no state needs all-or-nothing.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No query names this index and no ON
// CONFLICT clause targets it — every conflict target is account_members_pkey,
// which this migration keeps. The PK serves the same columns, so a
// still-running older API image plans the same queries after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_members_user_account`);
};

// Forward-only. Re-creating a duplicate of the primary key would only re-impose
// the write cost the advisor flags.
export const down = false;
