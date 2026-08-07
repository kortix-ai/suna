// Migration: goal_objective_health_indexes (NON-TRANSACTIONAL)
// Existing observation writes remain available while evaluation indexes build.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_project_goal_observations_evaluation_metric
      on kortix.project_goal_observations (evaluation_id, metric)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_project_goal_observations_evaluation
      on kortix.project_goal_observations (evaluation_id)
  `);
};

export const down = false;
