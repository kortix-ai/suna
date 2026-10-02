// Migration: connection_oauth_sessions_application_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_connection_oauth_sessions_application (kortix.ts) over
// application_id, the column of the connection_oauth_sessions_application_fk
// foreign key. The Supabase advisor's unindexed_foreign_keys lint flags the FK
// (KRTX-1100): without a covering index, every cascade delete on
// connection_oauth_applications seq-scans connection_oauth_sessions.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a
// failed build must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_connection_oauth_sessions_application
      on kortix.connection_oauth_sessions using btree (application_id)
  `);
};

export const down = false;
