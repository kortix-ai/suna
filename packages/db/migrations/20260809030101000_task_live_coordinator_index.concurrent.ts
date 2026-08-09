// Migration: task_live_coordinator_index
//
// A coordinator in review still owns the task. Include both doing and review
// in the liveness uniqueness fence used by bounded workers.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_tasks_live_liveness_coordinator
      ON kortix.project_tasks (liveness_coordinator_session_id)
      WHERE status IN ('doing', 'review') AND liveness_coordinator_session_id IS NOT NULL
  `);
};

export const down = false;
