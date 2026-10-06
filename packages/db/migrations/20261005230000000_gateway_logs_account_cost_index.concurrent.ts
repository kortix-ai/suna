// Migration: gateway_logs_account_cost_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_gateway_logs_account_cost for the cost-explorer rollups.
// GET /v1/usage/cost-summary + GET /v1/usage/cost-by-project run five and two
// same-slice 30-day aggregates over kortix.gateway_request_logs per call
// (apps/api/src/shared/cost-rollups.ts getCostSummary / listCostByProject).
// Each filters `account_id = $1 AND created_at >= $2 AND created_at < $3` and
// sums final_cost_precise / upstream_cost_precise / billing_mode, grouping by
// project_id or session_id.
//
// The only account-led index was idx_gateway_logs_account_time
// (account_id, created_at) with no INCLUDE, so every one of those sums was a
// heap fetch per row: the 30-day slice is ~10^6 rows on an active account
// (gateway usage writes grew from 5-15k/day in September past 150k/day by
// 2026-10-03), the statement blew the request-path 25 s statement_timeout
// (57014 -> 503), and every abort surfaced as a Sentry error under the
// catch-all drizzle queryWithCache fingerprint (Better Stack pattern
// 97669531..., KRTX-211). The 40-100 ms baseline of the same routes proves the
// DB was not saturated - the scan itself is the outlier.
//
// The INCLUDE columns are exactly what the cost-rollup aggregates read, so
// that whole slice becomes an index-only scan. The per-session aggregates in
// apps/api/src/shared/session-costs.ts (llmAggregateFields) also read ok and
// the token-count columns, which stay outside the INCLUDE on purpose: every
// extra included column widens every leaf tuple, and those aggregates read a
// single session's rows (session_id equality filters first), so their heap
// share is already small. They keep the same key columns as before - no
// regression, no index-only gain.
//
// The key columns are unchanged from the index this replaces
// (20261005230000100 drops idx_gateway_logs_account_time): the planner kept
// picking the narrower index while both existed, so the drop is load-bearing.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe (an INVALID leftover from a failed build must be
// dropped by hand first -- packages/db/MIGRATIONS.md), lock_timeout 180s (never
// the 2-5s plain-migration value: CONCURRENTLY waits on every older
// transaction and lock_timeout governs that wait), generous statement_timeout.
// INCLUDE lives only here: drizzle-orm 0.45's index builder cannot express it
// (same documented pattern as idx_gateway_logs_project_failed_time).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_gateway_logs_account_cost
      on kortix.gateway_request_logs (account_id, created_at) include (
        project_id, session_id, provider, resolved_model, billing_mode,
        final_cost_precise, upstream_cost_precise
      )
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
