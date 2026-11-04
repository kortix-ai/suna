// Migration: gateway_logs_project_session_time_llm  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The CONCURRENTLY escape hatch: CREATE INDEX CONCURRENTLY cannot run inside
// a transaction, and every plain .sql migration here runs inside the single
// batch transaction node-pg-migrate wraps around `pnpm migrate`
// (singleTransaction: true). See
// 20261104060001000_gateway_logs_project_time_covering_llm.concurrent.ts for
// the full house rules for this file class (one concurrent operation, IF NOT
// EXISTS, 180s lock_timeout -- lint-enforced --, generous statement_timeout).

export const shorthands = undefined;

// KRTX-4023: idx_gateway_logs_project_session_time
// (20261007050000009_gateway_logs_session_rollup_index.concurrent.ts) carries
// the per-session gateway rollup (listProjectGatewaySessionSpend,
// apps/api/src/shared/session-costs.ts -- GET /:projectId/gateway/sessions).
// KRTX-3560 (2026-10-27) added the LLM retail valuation fields to that
// rollup: its per-row case reads provider, resolved_model, cached_tokens,
// cache_write_tokens and the usage-was-estimated flag — none carried — so the
// rollup silently fell back to heap-fetching the wide jsonb rows with its
// siblings (the whole-dashboard deadline storms of KRTX-4023).
//
// The estimated flag is now a REAL column (20261104054916390 + backfill in
// 20261104060000000); this replacement adds it and the three token/model
// columns to the INCLUDE list over the same (project_id, session_id,
// created_at) keys and the same `session_id is not null` predicate. Built
// under a temp name; 20261104060005000 drops the old index and
// 20261104060006000 restores the canonical name the drizzle schema contract
// declares.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per call: a multi-statement string is an implicit
  // transaction block, which defeats noTransaction() (see the sibling
  // migration's header).
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_gateway_logs_project_session_time_llm
      on kortix.gateway_request_logs (project_id, session_id, created_at)
      include (account_id, ok, provider, resolved_model, requested_model,
               usage_estimated, billing_mode, final_cost_precise,
               upstream_cost_precise, input_tokens, output_tokens,
               cached_tokens, cache_write_tokens)
      where session_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
