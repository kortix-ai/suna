// Migration: admin_analytics_time_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Adds kortix.project_sessions (created_at) for the admin activity dashboard
// (apps/api/src/admin/analytics.ts -> GET /v1/admin/analytics/activity).
//
// WHY: that route runs `... where created_at >= $1 group by date_trunc('day', ...)`
// over a trailing 1-90 day window. Every existing index on the table leads with
// account_id, project_id, status, created_by or folder_id -- none of them can
// serve a global time range, so the query had to sequentially scan the entire
// session history on every dashboard load, and the page polls. The table is
// append-only on created_at, so this is the cheapest possible btree: inserts
// only ever touch the right-most leaf.
//
// NOT partial and NOT covering on purpose. A partial predicate would need the
// planner to prove implication against a bound parameter, and INCLUDE-ing the
// four grouped uuid columns would roughly triple the index size for a window
// whose heap pages are already physically clustered at the end of the table.
//
// Companion migration 20260807202731278 does the same for kortix.credit_ledger.
// They are separate files because a .concurrent.ts migration must contain
// exactly ONE concurrent operation (see the house rules in MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string --
  // a multi-statement string becomes an implicit transaction block and
  // CONCURRENTLY fails inside it.
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_sessions_created_at
      on kortix.project_sessions (created_at)
  `);
};

// Purely additive index. No down migration (repo policy -- see MIGRATIONS.md).
export const down = false;
