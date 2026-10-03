// Migration: drop_projects_updated_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_projects_updated` (updated_at, btree, ~2 MB), which no
// read path uses. Supabase's performance advisor flags it `unused_index` on
// `kortix.projects`, and pg_stat_user_indexes agrees: idx_scan = 0,
// idx_tup_read = 0, idx_tup_fetch = 0, with pg_stat_database.stats_reset null
// (never reset — zero means never used since the database started). Dropping
// it saves one index write on every project row update (every row's
// updated_at changes on each update).
//
// Why no read path uses it: the two account-filtered ORDER BY projects.updated_at
// reads (projects/routes/projects.ts, admin/index.ts) sort rows AFTER an
// account_id filter, which a single-column updated_at index cannot serve; the
// one unfiltered top-N read (provider-transition-prebuild.ts, WHERE
// status = 'active' ORDER BY updated_at DESC LIMIT n) could walk the index, but
// the planner never chose it — idx_scan = 0 means no plan, cached or otherwise,
// has ever referenced it — so removing it changes no plan that runs today.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer, and it only unlinks files (no heap rewrite). It cannot run
// in a transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// One statement, IF EXISTS: a re-run after a partial failure is safe and no
// state needs all-or-nothing.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names this index,
// and no ON CONFLICT clause targets it (projects' only conflict targets are
// the primary key and idx_projects_account_idempotency_key, both kept). A
// still-running older API image plans the same queries after the drop:
// idx_scan = 0 means no plan in use referenced the index, so removing it can
// only keep existing plans, never slow a query that used it.
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_projects_updated');
};

// Forward-only. Re-creating an index the planner never chose would re-impose
// its write cost with no read benefit.
export const down = false;
