// Migration: project_sessions_one_available_warm
//
// This additive partial unique index is the database arbiter for warm-session
// creation races. It allows one available warm session per project and creator.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_project_sessions_one_available_warm
      on kortix.project_sessions (project_id, created_by)
      where created_by is not null
        and metadata->'warm_session'->>'state' = 'available'
        and coalesce(metadata->>'deletedAt', '') = ''
  `);
};

export const down = false;
