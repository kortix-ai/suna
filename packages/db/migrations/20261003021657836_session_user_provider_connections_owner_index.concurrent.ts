// Migration: session_user_provider_connections_owner_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_session_user_provider_connections_owner, the covering index
// kortix.ts declares for the FK session_user_provider_connections_owner_fk
// (connection_id, user_id, provider_id) -> user_provider_connections. Until
// now the table only had the single-column
// session_user_provider_connections_connection, so the Supabase advisor
// reports the FK as unindexed and a cascade delete on
// user_provider_connections must find its session bindings by all three
// columns. One CONCURRENTLY build per file and per table (learnings: one
// CREATE INDEX CONCURRENTLY per table at a time).
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
    create index concurrently if not exists idx_session_user_provider_connections_owner
      on kortix.session_user_provider_connections using btree (connection_id, user_id, provider_id)
  `);
};

export const down = false;
