// Migration: session_sandboxes_provider_removal_pending_index  (NON-TRANSACTIONAL -- CREATE INDEX CONCURRENTLY)
//
// The provider-removal reaper (`removeArchivedProviderBoxes` in
// apps/api/src/projects/reaping/archived-box-removal.ts) retries every archived
// sandbox whose provider box removal is unconfirmed:
//
//   select sandbox_id, external_id, provider, metadata
//   from kortix.session_sandboxes
//   where status = $1
//     and external_id is not null
//     and metadata ? 'providerRemovalPendingAt'
//   order by metadata->>'providerRemovalRetryAfterAt' asc nulls first
//   limit 50;
//
// The only index on `status` (`idx_session_sandboxes_status`) does not know the
// pending-stamp predicate, so every lane run seq-scanned every archived row and
// decoded its jsonb to find (usually) nothing: measured on prod
// pg_stat_statements, mean 1609 ms over ~2300 calls, zero returned rows
// (KRTX-1309). This index carries the exact predicate, so the scan probes the
// reaper's (usually empty) pending set instead, and its second key is the
// query's sort expression so the rows come back ordered without a sort node.
//
// `status` is the leading KEY, not a partial-index predicate: the app binds it
// as a parameter, and a generic plan cannot prove `status = $1` implies
// `status = 'archived'` (verified: a status-predicate variant of this index
// drops out of the plan under plan_cache_mode = force_generic_plan). Prod's
// driver sends unnamed statements (custom plans), but the leading key costs
// nothing and keeps the plan correct under every plan mode. The partial
// predicates — `external_id is not null` and the jsonb key check — are static
// literals in the statement, so the planner proves them in any plan; they also
// keep a row stamped pending without an external box (unremovable) out of the
// index, so it cannot occupy the reaper's 50-row batch forever.
//
// The key is declared in `packages/db/src/schema/kortix.ts` without a sort
// clause on the expression (drizzle cannot attach ASC NULLS FIRST to an
// expression column); the migration below is what actually builds it, with the
// order the reaper reads.
//
// CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE on the table: it
// blocks no reader and no writer. It cannot run in a transaction, hence this
// .concurrent.ts file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is
// 180s: the statement waits for transactions that began before it
// (learnings 2026-08-19), and that wait blocks nobody.
//
// One statement, one file, IF NOT EXISTS: a re-run after a partial failure is
// safe and no state needs all-or-nothing.

export const shorthands = undefined;

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
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_provider_removal_pending
      on kortix.session_sandboxes (status, (metadata->>'providerRemovalRetryAfterAt') asc nulls first)
      where external_id is not null
        and metadata ? 'providerRemovalPendingAt'
  `);
};

// Forward-only. Dropping it would only give the slow plan back.
export const down = false;
