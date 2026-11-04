// Migration: drop_gateway_logs_project_time_covering_v1  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// mixed-version-safe: idx_gateway_logs_project_time_covering is only a planner
// choice, never named by code. Its INCLUDE list is a strict subset of
// idx_gateway_logs_project_time_covering_v2 (20261104060000000), which has the
// same key (project_id, created_at), so old and new API versions both plan
// index-only over v2. The insert-only log table pays one append per index, so
// the superseded index goes.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_gateway_logs_project_time_covering');
};

export const down = false;
