// Migration: service_accounts_project_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_service_accounts_project (kortix.ts) over project_id, the column
// of service_accounts_project_id_projects_project_id_fk (ON DELETE CASCADE).
// Supabase's unindexed_foreign_keys advisor flagged the FK (2026-10-02, prod
// read: every index on the table led with account_id or a hash; project_id
// led none). Without it, deleting a project seq-scans the table to find the
// service accounts its cascade removes, and (project_id, ...) filters such as
// the project-audit agent lookup seq-scan too. Table holds ~5k rows (1.2 MB),
// so the build is cheap; CONCURRENTLY is still the house rule for any index
// on an existing table. Full index, not partial: the FK check must cover
// every row and the advisor's coverage test is simplest to satisfy.
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
    create index concurrently if not exists idx_service_accounts_project
      on kortix.service_accounts using btree (project_id)
  `);
};

export const down = false;
