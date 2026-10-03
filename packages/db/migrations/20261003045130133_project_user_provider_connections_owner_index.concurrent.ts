// Migration: project_user_provider_connections_owner_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as idx_project_user_provider_connections_owner
// over the FK project_user_provider_connections_owner_fk (connection_id, user_id,
// provider_id) -> user_provider_connections ON DELETE CASCADE. The only index on
// those three columns was the connection-only one above it, which does not match
// the FK's column set: the Supabase unindexed-foreign-keys advisor flags the FK,
// and a cascade delete on user_provider_connections probes this table with all
// three columns. One CONCURRENTLY build per file and per table (learnings: one
// CREATE INDEX CONCURRENTLY per table at a time).
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
    create index concurrently if not exists idx_project_user_provider_connections_owner
      on kortix.project_user_provider_connections using btree (connection_id, user_id, provider_id)
  `);
};

export const down = false;
