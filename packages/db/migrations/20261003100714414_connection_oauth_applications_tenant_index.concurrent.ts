// Migration: connection_oauth_applications_tenant_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_connection_oauth_applications_tenant (kortix.ts) for the composite
// foreign key connection_oauth_applications_connection_tenant_fk
// (account_id, project_id, connector_id, connection_id →
// kortix.connector_connections, from
// 20260806140107656_connector_physical_cutover.sql): the Supabase performance
// advisor flags it unindexed (unindexed_foreign_keys), so every RI check on
// the FK -- e.g. the ON DELETE cascade from connector_connections -- seq-scans
// the table. The existing indexes lead with connection_id (unique) and
// project_id; neither leads with account_id, so neither serves the FK.
//
// IF NOT EXISTS keeps a re-run safe (an INVALID leftover from a failed build
// must be dropped by hand first -- packages/db/MIGRATIONS.md). lock_timeout is
// 180s, never the 2-5s plain-migration value: CREATE INDEX CONCURRENTLY waits
// on every older transaction and lock_timeout governs that wait.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_connection_oauth_applications_tenant
      on kortix.connection_oauth_applications using btree (account_id, project_id, connector_id, connection_id)
  `);
};

export const down = false;
