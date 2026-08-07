// Migration: task_git_write_reconcile_index (NON-TRANSACTIONAL)
// The recurring reconciler scans only expired durable `live` requests.
// CREATE INDEX CONCURRENTLY keeps project_tasks writable during deployment.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_tasks_git_write_reconcile
      on kortix.project_tasks (git_write_lease_expires_at, task_id)
      where git_write_state = 'live'
  `);
};

export const down = false;
