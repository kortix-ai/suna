// Migration: project_sessions_space_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_project_sessions_space (kortix.ts) for the space_id column added
// by 20261020165303440_project_spaces.sql. It serves the channel/DM thread
// list (one space's threads, newest first). Partial on space_id IS NOT NULL:
// sessions outside a space are never listed by it.
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
    create index concurrently if not exists idx_project_sessions_space
      on kortix.project_sessions using btree (project_id, space_id, created_at desc, session_id desc)
      where space_id is not null
  `);
};

export const down = false;
