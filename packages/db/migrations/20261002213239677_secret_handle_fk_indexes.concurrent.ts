// Migration: secret_handle_fk_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Covers the two foreign keys on kortix.project_session_secret_handles that
// have no index leading with their column: project_id and secret_id. A delete
// or update on the referenced row (projects, project_secrets) then scans the
// whole table to find the referencing rows, which is the Supabase advisor's
// unindexed_foreign_keys lint. The existing indexes on this table all lead
// with lookup_id or session_id (20260728132613912_secret_delivery_indexes
// .concurrent.ts), so neither FK had one.
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
  // implicit transaction block and CONCURRENTLY then fails. Also one index
  // build at a time on the table: two concurrent builds starve each other's
  // lock-acquisition points (learnings 2026-08-10).
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_secret_handles_project
      on kortix.project_session_secret_handles using btree (project_id)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_secret_handles_secret
      on kortix.project_session_secret_handles using btree (secret_id)
  `);
};

export const down = false;
