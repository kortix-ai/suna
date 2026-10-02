// Migration: sandbox_compute_sessions_app_runtime_id_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_sandbox_compute_sessions_app_runtime_id (kortix.ts), the covering
// index for sandbox_compute_sessions_app_runtime_fk
// (app_runtime_id -> kortix.app_runtimes.runtime_id, ON DELETE SET NULL; the
// advisor finding sits next to ledger_id on the same table). Deleting an
// app runtime has to find the compute sessions to null without it; the same
// column serves the app-runtime joins (apps/budget.ts). Partial on
// app_runtime_id IS NOT NULL: only app-workload rows carry it, session rows
// stay out of the index.
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
    create index concurrently if not exists idx_sandbox_compute_sessions_app_runtime_id
      on kortix.sandbox_compute_sessions using btree (app_runtime_id)
      where app_runtime_id is not null
  `);
};

export const down = false;
