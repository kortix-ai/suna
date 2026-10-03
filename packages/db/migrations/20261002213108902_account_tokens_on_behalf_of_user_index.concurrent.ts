// Migration: account_tokens_on_behalf_of_user_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_account_tokens_on_behalf_of_user (kortix.ts) for the SQL-only
// foreign key account_tokens_on_behalf_of_user_fk (ON DELETE SET NULL, added
// NOT VALID by 20260922135103135_agent_session_on_behalf_of): deleting an auth
// user nulls on_behalf_of_user_id on that user's tokens, and that column had no
// index, so every SET NULL walk seq-scans the table. The Supabase advisor flags
// it as unindexed_foreign_keys (KRTX-1091). auth.users is outside the Drizzle
// schema, so the FK exists only in SQL; the index is declared in kortix.ts.
//
// Partial on on_behalf_of_user_id IS NOT NULL: unattended runs (trigger, cron,
// webhook, channel without a linked user) carry NULL, and a FK enforcement scan
// never matches a NULL.
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
    create index concurrently if not exists idx_account_tokens_on_behalf_of_user
      on kortix.account_tokens using btree (on_behalf_of_user_id)
      where on_behalf_of_user_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
