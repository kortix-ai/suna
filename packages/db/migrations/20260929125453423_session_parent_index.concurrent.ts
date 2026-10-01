// Migration: session_parent_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_project_sessions_parent (kortix.ts) for the parent_session_id column
// added by 20260929125443169_session_initiator.sql. It serves the session list's
// `parent=<session_id>` read (one coordinator's children, newest first). Partial
// on parent_session_id IS NOT NULL: top-level sessions are never looked up by it.
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
    create index concurrently if not exists idx_project_sessions_parent
      on kortix.project_sessions using btree (parent_session_id, updated_at desc, session_id desc)
      where parent_session_id is not null
  `);
};

export const down = false;
