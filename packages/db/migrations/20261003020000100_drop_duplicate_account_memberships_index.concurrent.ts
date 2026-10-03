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
// The preceding migration (20261003020000000_account_memberships_replica_
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
//
// FK binding (prod): kortix.account_secret_grants.account_secret_grants_member_fk
// references (user_id, account_id) and on prod is bound to THIS index, not to the
// PK (pg_constraint.conindid), so a bare DROP INDEX fails with 2BP01. Dev and
// staging bind it to the PK. Re-point it: drop the FK, drop the index, re-add the
// FK NOT VALID (it now binds to the PK, the only remaining unique index), then
// VALIDATE. account_secret_grants is tiny (2 rows on prod). The FK steps take
// ACCESS EXCLUSIVE on account_secret_grants and SHARE ROW EXCLUSIVE on
// account_memberships (blocks its rare writes, never its reads).
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  // Dropping first makes the sequence re-runnable: a retry after any partial
  // failure drops whatever FK exists and rebuilds it against the PK.
  pgm.sql(`alter table kortix.account_secret_grants drop constraint if exists account_secret_grants_member_fk`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_members_user_account`);
  pgm.sql(`alter table kortix.account_secret_grants add constraint account_secret_grants_member_fk foreign key (user_id, account_id) references kortix.account_memberships (user_id, account_id) on delete cascade not valid`);
  pgm.sql(`alter table kortix.account_secret_grants validate constraint account_secret_grants_member_fk`);
};

// Forward-only. Re-creating a duplicate of the primary key would only re-impose
// the write cost the advisor flags.
export const down = false;
