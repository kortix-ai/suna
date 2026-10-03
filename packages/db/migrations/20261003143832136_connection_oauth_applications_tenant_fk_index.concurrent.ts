// Migration: connection_oauth_applications_tenant_fk_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds connection_oauth_applications_connection_tenant_fk (kortix.ts) for the
// composite foreign key `connection_oauth_applications_connection_tenant_fk` —
// the exact FK the Supabase performance advisor reports as
// `unindexed_foreign_keys` on `kortix.connection_oauth_applications`
// (columns 2-5: account_id, project_id, connector_id, connection_id →
// connector_connections' idx_connector_connections_tenant_identity).
//
// The FK is ON DELETE CASCADE (ON UPDATE NO ACTION): deleting a
// connector_connections row makes Postgres scan connection_oauth_applications
// to find the rows that reference it, and a key-column UPDATE RI-checks it the
// same way. No existing index leads with
// account_id: idx_connection_oauth_applications_connection leads with
// connection_id and idx_connection_oauth_applications_project with project_id,
// and the advisor's covering rule wants the FK's column list in order. The
// index takes the constraint's name, Postgres's convention for the index that
// serves an FK — the psql \d hint and every FK-covering-index tooling looks it
// up that way (same choice as 20261003010107485_basejump_accounts_fk_covering_indexes).
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe (an INVALID leftover from a failed build must be
// dropped by hand first -- packages/db/MIGRATIONS.md), lock_timeout 180s (never
// the 2-5s plain-migration value: CONCURRENTLY waits on every older
// transaction and lock_timeout governs that wait), generous statement_timeout.
// No table-presence guard: the baseline migration chain always creates
// kortix.connection_oauth_applications (20260806140107656 renames it into
// place), so every database that reaches this file has the table and the FK.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists connection_oauth_applications_connection_tenant_fk
      on kortix.connection_oauth_applications
        using btree (account_id, project_id, connector_id, connection_id)
  `);
};

// One-way in practice: an index build needs no down migration (MIGRATIONS.md).
export const down = false;
