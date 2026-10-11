// Migration: gateway_logs_account_time_covering  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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

export const shorthands = undefined;

// The cost explorer's account+window aggregates all scan
// kortix.gateway_request_logs by (account_id, created_at) and aggregate the
// same ~12 narrow columns:
//
//   GET /v1/usage/cost-summary   (apps/api/src/shared/cost-rollups.ts,
//                                 getCostSummary: totals, daily series, model
//                                 breakdown, distinct projects)
//   GET /v1/usage/cost-by-project (listCostByProject: spend grouped by project)
//   GET /v1/usage/session-costs  (apps/api/src/shared/session-costs.ts,
//                                 llmAggregateSubquery: per-session LLM
//                                 rollup, incl. count(*) filter (where not ok))
//
// idx_gateway_logs_account_time (account_id, created_at) locates the rows but
// carries none of the aggregated columns, so every scan fetches each row from
// the heap -- and these rows are wide (request/response jsonb payloads). The
// explorer runs several of these scans per page load; measured on prod
// (Server-Timing, 2026-10-04): one /v1/usage/cost-summary request logged
// db;dur=4.5-25s across n=10 statements on the largest account, with 503s at
// the 25s ceiling, while a repeat seconds later settled at ~0.1s -- the
// latency is heap I/O, not CPU. INCLUDE carries every column those
// aggregates read, so the scans become index-only and never touch the wide
// heap rows. `ok` is included for the session-costs error_count filter;
// billing_mode for the BYOK spend split (llm-spend.ts).
//
// The table is insert-only (gateway logs are written once and deleted only by
// account deletion), so the index pays an append cost per insert and no HOT
// update path is lost. The existing idx_gateway_logs_account_time stays: this
// migration only adds.
//
// Drizzle's index builder cannot express INCLUDE, so kortix.ts declares this
// index without it -- the schema contract only checks relation + uniqueness,
// the same pattern as idx_gateway_logs_project_failed_time
// (20260926234956893_gateway_logs_project_ok_time.concurrent.ts).
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
    create index concurrently if not exists idx_gateway_logs_account_time_covering
      on kortix.gateway_request_logs (account_id, created_at) include (
        session_id,
        project_id,
        provider,
        resolved_model,
        billing_mode,
        ok,
        final_cost_precise,
        upstream_cost_precise,
        input_tokens,
        output_tokens,
        cached_tokens,
        cache_write_tokens
      )
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
