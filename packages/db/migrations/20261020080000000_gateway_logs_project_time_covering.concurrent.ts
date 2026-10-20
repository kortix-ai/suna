// Migration: gateway_logs_project_time_covering  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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

// The project-led gateway aggregates all scan kortix.gateway_request_logs by
// (project_id, created_at) and aggregate the same narrow money/token columns:
//
//   GET /v1/projects/:id/gateway/budgets (apps/api/src/projects/routes/
//     gateway-spend.ts): memberRows (per-member count/cost/tokens) and
//     projectAgg (project count/cost) over month-to-date, and budgetSpends
//     (apps/api/src/llm-gateway/budgets.ts) which sums one filtered window
//     per budget over the same scan (member budgets add an actor_user_id
//     predicate). Prod (Better Stack 2346961, 2026-10-18 07:54): the
//     15-minute budgets poll of a busy project crossed the 25 s statement
//     timeout -- "canceling statement due to statement timeout" on
//     `select count(*)::int, coalesce(sum(final_cost_precise + ...), 0)::float8
//     from gateway_request_logs where project_id = $1 and created_at >=
//     date_trunc('month', now())` -- 503 + a Better Stack error page. The
//     neighboring polls of the same project ran 2-14 s each: the latency is
//     heap I/O, not a convoy.
//   GET /v1/projects/:id/gateway/overview and /gateway/series (same file):
//     the same project+window scan aggregating ok, both cost columns,
//     billing_mode, both token counts -- and the series also
//     percentile_cont(...) within group (order by latency_ms).
//
// idx_gateway_logs_project_time (project_id, created_at) locates the rows but
// carries none of the aggregated columns, so every scan fetches each row from
// the heap -- and these rows are wide (request/response jsonb payloads). INCLUDE
// carries every column those aggregates read, so the scans become index-only
// and never touch the wide heap rows. The per-session rollup keeps its own
// partial index (idx_gateway_logs_project_session_time,
// 20261007050000009) and the account-led cost explorer keeps
// idx_gateway_logs_account_time_covering (20261008012757000): this migration
// only adds, for the project-led scans those two cannot serve.
//
// The table is insert-only (gateway logs are written once and deleted only by
// account deletion), so the index pays an append cost per insert and no HOT
// update path is lost. The existing idx_gateway_logs_project_time stays: the
// full-row list endpoint (GET /:projectId/gateway) reads the wide rows and
// keeps its heap path.
//
// Drizzle's index builder cannot express INCLUDE, so kortix.ts declares this
// index without it -- the schema contract only checks relation + uniqueness,
// the same pattern as idx_gateway_logs_account_time_covering.
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
    create index concurrently if not exists idx_gateway_logs_project_time_covering
      on kortix.gateway_request_logs (project_id, created_at) include (
        ok,
        billing_mode,
        final_cost_precise,
        upstream_cost_precise,
        input_tokens,
        output_tokens,
        latency_ms,
        actor_user_id
      )
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
