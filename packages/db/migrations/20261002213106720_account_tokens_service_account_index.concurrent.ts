// Migration: account_tokens_service_account_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_account_tokens_service_account (kortix.ts) for the foreign key
// account_tokens_service_account_id_service_accounts_service_account_id_fk
// (ON DELETE CASCADE, added by 20260628060000001_d2_agent_service_account_identity):
// deleting a service account walks kortix.account_tokens by service_account_id,
// and that column had no index, so every cascade seq-scans the table. The Supabase
// advisor flags it as unindexed_foreign_keys (KRTX-1091).
//
// Partial on service_account_id IS NOT NULL: laptop CLI PATs and project tokens
// carry NULL, and a FK enforcement scan never matches a NULL.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build must
// be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_account_tokens_service_account
      on kortix.account_tokens using btree (service_account_id)
      where service_account_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
