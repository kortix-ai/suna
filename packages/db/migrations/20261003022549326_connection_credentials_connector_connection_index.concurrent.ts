// Migration: connection_credentials_connector_connection_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as idx_connection_credentials_connector_connection
// for the foreign key connection_credentials_connector_connection_fk
// (connector_id, connection_id) -> kortix.connector_connections, ON DELETE
// CASCADE. That FK had no covering index: the two single-column indexes and
// both partial unique indexes cannot serve the composite FK check, so every
// connector_connections delete scanned connection_credentials. Supabase
// advisor lint: unindexed_foreign_keys.
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
    create index concurrently if not exists idx_connection_credentials_connector_connection
      on kortix.connection_credentials using btree (connector_id, connection_id)
  `);
};

export const down = false;
