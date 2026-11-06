// Migration: goals_sessions_index  (NON-TRANSACTIONAL -- concurrent index)
//
// The goals delivery guard asks, before every queued prompt runs, which goal the
// session works or worked for: `project_goals.sessions @> '[{"id": ...}]'`. A GIN
// index (jsonb_path_ops) keeps that lookup off a scan of project_goals.
// project_goals is new in 20261106085648346_goals.sql; the index is built
// concurrently anyway so the migration lint holds and no write is blocked.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction, which defeats noTransaction() for CONCURRENTLY.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_goals_sessions
      on kortix.project_goals using gin (sessions jsonb_path_ops)
  `);
};

export const down = false;
