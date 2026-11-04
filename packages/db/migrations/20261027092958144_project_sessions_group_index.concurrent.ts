// Migration: project_sessions_group_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_project_sessions_group (kortix.ts) for the group_id column added
// by 20261027092958143_project_session_groups.sql. It serves one group's
// sessions in the session list order (updated_at desc, session_id desc), so
// the keyset cursor walks the index, and the FK's ON DELETE SET NULL when a
// group is deleted. group_id is unique to one project, so project_id is not a
// key column. Partial on group_id IS NOT NULL: sessions in no group are never
// listed by it.
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
    create index concurrently if not exists idx_project_sessions_group
      on kortix.project_sessions using btree (group_id, updated_at desc, session_id desc)
      where group_id is not null
  `);
};

export const down = false;
