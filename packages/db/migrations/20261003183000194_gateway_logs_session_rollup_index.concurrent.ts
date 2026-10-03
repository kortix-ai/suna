// Migration: gateway_logs_session_rollup_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around `pnpm migrate` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     `lock_timeout` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the one lock a CONCURRENTLY build holds
//     (ShareUpdateExclusive on the table) only excludes other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails `pnpm --filter @kortix/db lint`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

// Covering index for the per-session gateway rollup (KRTX-1311,
// source:supabase slow query on kortix.gateway_request_logs):
// listProjectGatewaySessionSpend (apps/api/src/shared/session-costs.ts) --
// GET /v1/projects/{projectId}/gateway/sessions -- aggregates one project's
// gateway logs per session_id over a day window (1..365, default 30):
//
//   select session_id, count(*)::int, count(*) filter (where not ok)::int,
//          sum(final_cost_precise + <billing-mode-aware upstream cost>), ...
//     from kortix.gateway_request_logs
//    where account_id = $1 and project_id = $2 and session_id is not null
//      and created_at >= now() - make_interval(days => $3)
//    group by session_id
//
// Prod (2026-10-03, pg_stat_statements, read-only Management API): mean
// 1150.9 ms over 150 calls (172.6 s total), buffer hit rate 81%. EXPLAIN
// (ANALYZE, BUFFERS): a BitmapAnd of two index bitmaps feeds a Bitmap Heap
// Scan that touches 45,909 blocks (41,762 hit + 4,147 read, ~358 MB heap) for
// ~346k rows, then an external-merge sort spills ~36 MB to temp just to order
// the rows by session_id for the GroupAggregate. No existing index carries the
// aggregated columns, so every row pays a heap fetch, and none of the existing
// key orders yields session_id order, so every plan pays the sort.
//
// This index serves the whole aggregate from the index alone: keys
// (project_id, session_id, created_at) give the GROUP BY session_id order for
// a fixed project (no sort), and INCLUDE carries every referenced column
// (account_id, ok, both cost columns, billing_mode, both token counts,
// requested_model), so the plan becomes an index-only scan with zero heap
// fetches. `session_id is not null` is partial because the rollup never reads
// non-session spend (model playground etc.); on prod that is 2.4% of rows
// (27,448 of 1,123,664, read-only count 2026-10-03). The visibility map must
// be current for an index-only scan; the table is insert-only and autovacuum
// maintains it (pg_stat_user_tables: last_autovacuum 2026-10-02 21:18 UTC).
//
// The other per-session rollup (llmAggregateSubquery in the same file) filters
// account_id + created_at without a project, so it keeps its
// idx_gateway_logs_account_time path; this index is not for it.
//
// The declaration in packages/db/src/schema/kortix.ts cannot express INCLUDE
// (drizzle-orm 0.45's index builder), so it declares keys + predicate only and
// this migration builds the real definition -- same pattern as
// idx_gateway_logs_project_failed_time (20260926234956893).

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
    create index concurrently if not exists idx_gateway_logs_project_session_time
      on kortix.gateway_request_logs (project_id, session_id, created_at)
      include (account_id, ok, final_cost_precise, upstream_cost_precise,
               billing_mode, input_tokens, output_tokens, requested_model)
      where session_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
