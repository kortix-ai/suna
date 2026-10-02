// Migration: project_trigger_executions_session_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_project_trigger_executions_session (kortix.ts) for the
// project_trigger_exec_session_fk foreign key (session_id ->
// kortix.project_sessions.session_id, ON DELETE set null): deleting a session
// runs that FK's set-null update, and with no index leading with session_id it
// sequential-scans the whole table per deleted session. Supabase's
// unindexed_foreign_keys advisor flagged it (KRTX-1108). The app never queries
// this table by session_id, so the index serves the FK action alone.
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
    create index concurrently if not exists idx_project_trigger_executions_session
      on kortix.project_trigger_executions using btree (session_id)
  `);
};

export const down = false;
