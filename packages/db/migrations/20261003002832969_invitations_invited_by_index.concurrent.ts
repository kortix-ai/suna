// Migration: invitations_invited_by_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Indexes the two unindexed foreign keys of the prod-only legacy table
// basejump.invitations:
//
//   invitations_invited_by_user_id_fkey  (invited_by_user_id → auth.users.id)
//   invitations_account_id_fkey          (account_id → basejump.accounts.id)
//
// The Supabase performance advisor flags both (unindexed_foreign_keys):
// without a covering index, every DELETE/UPDATE on the referenced key takes an
// expensive referential check that scans the whole table. Nothing in this repo
// reads or writes the table (the app's invitations live in
// kortix.account_invitations); basejump is retired-but-present —
// 20260706120000000_retire_basejump deliberately left the schema in place.
// Fresh self-host/CI databases build only the basejump.account_user stub
// (scripts/test-prereqs.sql), so the CREATE INDEX calls are skipped entirely
// when the table is absent — same to_regclass guard pattern as that migration.
//
// Two builds, strictly sequential: parallel CREATE INDEX CONCURRENTLY builds on
// one table starve each other's lock-acquisition points (learnings 2026-08-10).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a
// failed build must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // Catalog probe runs inside the still-open batch transaction (read-only);
  // the CONCURRENTLY statements queue through pgm.sql and run after the runner
  // commits that transaction — CONCURRENTLY cannot run inside any transaction.
  const present = await pgm.db.query(
    `select to_regclass('basejump.invitations') is not null as present`,
  );
  if (!present.rows[0]?.present) return;

  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(`
    create index concurrently if not exists idx_invitations_invited_by_user_id
      on basejump.invitations using btree (invited_by_user_id)
  `);
  await pgm.sql(`
    create index concurrently if not exists idx_invitations_account_id
      on basejump.invitations using btree (account_id)
  `);
};

export const down = false;
