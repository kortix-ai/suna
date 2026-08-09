// Migration: goal_evaluation_fired_index (NON-TRANSACTIONAL)
// Goal pushes and health reads remain available while the partial order index builds.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_goal_evaluations_goal_fired
      on kortix.project_goal_evaluations (project_id, goal_slug, fired_at desc)
      where state = 'fired'
  `);
};

export const down = false;
