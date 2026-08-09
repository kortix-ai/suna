// Migration: task_live_claim_session_index
//
// A coordinator in review still owns the task. Include both doing and review
// in the durable uniqueness fence so one session cannot coordinate two tasks.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_tasks_live_claim_session
      ON kortix.project_tasks (claim_session_id)
      WHERE status IN ('doing', 'review') AND claim_session_id IS NOT NULL
  `);
};

export const down = false;
