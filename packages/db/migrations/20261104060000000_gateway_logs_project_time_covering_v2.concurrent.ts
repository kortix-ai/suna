// Migration: gateway_logs_project_time_covering_v2  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// CREATE INDEX CONCURRENTLY cannot run in a transaction; see
// 20261020080000000_gateway_logs_project_time_covering.concurrent.ts for the
// rules of this file type (one concurrent operation, IF NOT EXISTS, generous
// lock_timeout).
//
// Why (KRTX-4022): GET /v1/projects/:id/gateway/series on the busiest project
// ran 5-24 s per call and crossed the 25 s server processing deadline (503,
// Better Stack, 2026-11-04). 20261020080000000 made the series scan index-only
// by carrying every column it read. KRTX-3560 (2026-10-27) then added
// provider, resolved_model, cached_tokens, cache_write_tokens and
// metadata->>'usageEstimated' to the same aggregate (rowLlmValueSql in
// apps/api/src/shared/llm-value.ts), and none of them is in that index. Since
// then every row of the window is fetched from the wide heap again.
//
// This index is the old one plus those five columns. metadata is a jsonb that
// can carry upstream failure text, and a btree tuple has a hard size limit: the
// writer (buildGatewayTraceRow in apps/api/src/shared/gateway-trace-row.ts)
// bounds it to 2000 bytes so the INSERT of a trace row can never be rejected by
// this index. The old index is dropped by 20261104060000001: this one serves
// every query it served.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_gateway_logs_project_time_covering_v2
      on kortix.gateway_request_logs (project_id, created_at) include (
        ok,
        billing_mode,
        final_cost_precise,
        upstream_cost_precise,
        input_tokens,
        output_tokens,
        latency_ms,
        actor_user_id,
        provider,
        resolved_model,
        cached_tokens,
        cache_write_tokens,
        metadata
      )
  `);
};

export const down = false;
