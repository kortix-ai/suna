// Migration: connector_connections_tunnel_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds the index kortix.ts declares as idx_connector_connections_tunnel for the column added by
// 20260928210714434_computer_accounts.sql. One CONCURRENTLY build per file and
// per table (learnings: one CREATE INDEX CONCURRENTLY per table at a time).
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
    create index concurrently if not exists idx_connector_connections_tunnel
      on kortix.connector_connections using btree (tunnel_id)
  `);
};

export const down = false;
