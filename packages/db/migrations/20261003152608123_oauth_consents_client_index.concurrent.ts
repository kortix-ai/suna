// Migration: oauth_consents_client_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_oauth_consents_client (kortix.ts) to cover the
// oauth_consents_client_fk foreign key: deleting an oauth client cascades to its
// consents by client_id, and no existing index leads with it (the
// (user_id, client_id) unique index serves the per-user read only). Supabase
// advisor unindexed_foreign_keys on kortix.oauth_consents.
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
    create index concurrently if not exists idx_oauth_consents_client
      on kortix.oauth_consents using btree (client_id)
  `);
};

export const down = false;
