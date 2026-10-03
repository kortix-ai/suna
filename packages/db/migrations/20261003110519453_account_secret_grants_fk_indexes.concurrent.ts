// Migration: account_secret_grants_fk_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the two FK-covering indexes kortix.ts declares on
// kortix.account_secret_grants. Both composite foreign keys had no index
// whose leading columns match them, so the Supabase advisor reports
// `unindexed_foreign_keys` on the table twice:
//
//   account_secret_grants_resource_fk (secret_id, account_id)
//     -> kortix.account_secret_resources(secret_id, account_id)
//   account_secret_grants_member_fk   (user_id, account_id)
//     -> kortix.account_memberships(user_id, account_id)
//
// Without them, deleting a secret resource or an account membership scans the
// grants table to find the rows the FK cascades. The lint's covering rule is
// exact: the index's leading columns must equal the FK's columns in order, so
// the existing PK (secret_id, user_id) and account_secret_grants_member
// (account_id, user_id) cover neither.
//
// Two statements, one file, in the order shown: each is IF NOT EXISTS and
// independent, so a re-run after a partial failure is safe. They run
// sequentially (learnings: one CREATE INDEX CONCURRENTLY per table at a time).
// An INVALID leftover from a failed build must be dropped by hand first
// (see packages/db/MIGRATIONS.md).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. The one lock it holds (ShareUpdateExclusive) blocks no user.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_account_secret_grants_secret_account
      on kortix.account_secret_grants using btree (secret_id, account_id)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_account_secret_grants_user_account
      on kortix.account_secret_grants using btree (user_id, account_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
