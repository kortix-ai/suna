// Migration: session_worker_log_append_id_unique
//
// `session_worker_log` already exists and receives writes while sessions run.
// Build its new unique index without blocking those appends.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_session_worker_log_append_id
      on kortix.session_worker_log (session_id, append_id)
  `);
};

export const down = false;
