// Migration: account_secret_project_id_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_account_secret_resources_project_id (kortix.ts) for the
// account_secret_resources.project_id foreign key
// (account_secret_resources_project_id_projects_project_id_fk, added by
// 20260917053412446_account_secret_project_access.sql): a project delete
// cascades into this table by project_id, and every FK check on it
// (Supabase advisor: unindexed_foreign_keys) otherwise seq-scans the table.
// The existing indexes lead with account_id / secret_id, never project_id.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe (an INVALID leftover from a failed build must be
// dropped by hand first -- packages/db/MIGRATIONS.md), lock_timeout 180s (never
// the 2-5s plain-migration value: CONCURRENTLY waits on every older
// transaction and lock_timeout governs that wait), generous statement_timeout.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_account_secret_resources_project_id
      on kortix.account_secret_resources using btree (project_id)
  `);
};

export const down = false;
