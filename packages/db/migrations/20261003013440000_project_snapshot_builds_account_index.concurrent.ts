// Migration: project_snapshot_builds_account_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as idx_project_snapshot_builds_account:
// a single-column btree on kortix.project_snapshot_builds(account_id). The
// table's other two indexes both lead with project_id, so the account_id
// foreign key (accounts.account_id, ON DELETE CASCADE) had no covering index:
// deleting an account row scanned the whole table to find its snapshot builds,
// and the Supabase advisor flagged it as unindexed_foreign_keys
// (project_snapshot_builds_account_id_accounts_account_id_fk).
//
// One CONCURRENTLY build per file and per table (learnings: one CREATE INDEX
// CONCURRENTLY per table at a time). Purely additive: a new non-unique btree,
// no code depends on its absence, and CREATE INDEX CONCURRENTLY never blocks
// writes.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. The one lock it holds (ShareUpdateExclusive) blocks no user.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build
// must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_snapshot_builds_account
      on kortix.project_snapshot_builds using btree (account_id)
  `);
};

export const down = false;
