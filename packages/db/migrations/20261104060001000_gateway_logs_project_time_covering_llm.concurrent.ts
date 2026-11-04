// Migration: gateway_logs_project_time_covering_llm  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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

export const shorthands = undefined;

// KRTX-4023: the LLM retail valuation (KRTX-3560, 2026-10-27) composed its
// per-row case (rowLlmValueSql in apps/api/src/shared/llm-value.ts) into the
// project-led gateway aggregates. That case reads provider, resolved_model,
// cached_tokens, cache_write_tokens and the usage-was-estimated flag; the
// breakdown's group key additionally reads the served model and
// requested_model; the sources rollup filters account_id and reads
// session_id. idx_gateway_logs_project_time_covering (20261020080000000)
// carried none of them, so every gateway overview/series/breakdown/sessions/
// sources scan silently fell back to heap-fetching the wide request/response
// jsonb rows, and a busy project's dashboard polls crossed the 25 s statement
// timeout as 5xx (whole-dashboard deadline storms).
//
// The served model and the estimated flag are now REAL columns
// (20261104054916390 + the backfill in 20261104060000000) — a jsonb
// expression cannot join an INCLUDE list, and a btree expression key never
// serves an index-only scan (verified on PG 17.6), so columns were the only
// path back to index-only. This replacement carries every column the
// aggregates read as plain INCLUDE columns over the same (project_id,
// created_at) keys. Built under a temp name (the final name is still held by
// the old index); 20261104060003000 drops the old index and
// 20261104060004000 restores the canonical name the drizzle schema contract
// declares. WITH ISVALID: if you're re-running this file by hand after an
// INVALID build, drop the invalid index first.
//
// The visibility map must be current for an index-only scan; the table is
// insert-only and autovacuum maintains it.

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
    create index concurrently if not exists idx_gateway_logs_project_time_covering_llm
      on kortix.gateway_request_logs (project_id, created_at)
      include (account_id, session_id, ok, provider, requested_model,
               resolved_model, served_model, usage_estimated, billing_mode,
               final_cost_precise, upstream_cost_precise, input_tokens,
               output_tokens, cached_tokens, cache_write_tokens, latency_ms,
               actor_user_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
