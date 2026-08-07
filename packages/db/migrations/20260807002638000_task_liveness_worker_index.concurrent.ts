// Migration: task_liveness_worker_index (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// project_tasks can contain rows because the generated-state migration runs
// first. pgm.noTransaction() is required: PostgreSQL rejects CONCURRENTLY in a
// transaction, and the migration runner otherwise wraps the batch.

export const shorthands = undefined;

/** @param { noTransaction: () => void; sql: (query: string) => void } pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_project_tasks_liveness_worker
      on kortix.project_tasks (liveness_worker_session_id)
      where liveness_worker_session_id is not null
  `);
};

export const down = false;
