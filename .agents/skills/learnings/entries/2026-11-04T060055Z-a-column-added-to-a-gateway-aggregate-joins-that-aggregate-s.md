---
recorded: 2026-11-04T06:00:55Z
incident_date: 2026-11-04
---
# A column added to a gateway aggregate joins that aggregate's covering index in the same change

**Rule:** When you add a column to the project-led aggregates over `kortix.gateway_request_logs` (gateway overview, series, budgets), add it to the INCLUDE list of the covering index `idx_gateway_logs_project_time_covering_v2` in the same change. One missing column turns the index-only scan into a heap fetch of every wide row in the window. A column in INCLUDE must stay under the btree tuple limit (an insert over it fails with `index row requires N bytes, maximum size is 8191`): `metadata` is bounded to 2000 bytes in `buildGatewayTraceRow`; bound any other free-text column the same way before adding it.

**Trigger surface:** Editing `rowLlmValueSql`, `llm-spend.ts` or any select in `gateway-spend.ts` / `lib/gateway-series.ts` that reads a new `gateway_request_logs` column.

**Incident:** 2026-11-04, KRTX-4022. KRTX-3560 (2026-10-27) made the series read `provider`, `resolved_model`, `cached_tokens`, `cache_write_tokens` and `metadata`. The covering index of 2026-10-20 carried none of them. On the busiest project `GET /v1/projects/:id/gateway/series` then ran 5-24 s and 4 calls in 24 h crossed the 25 s deadline (503).

**Enforcement:** `apps/api/src/projects/lib/gateway-series.integration.test.ts` runs the real series query under EXPLAIN with heap scans off and fails unless the plan is an Index Only Scan of the `_v2` index. Also `gateway-series.integration.test.ts` inserts a trace with huge upstream failure text through `buildGatewayTraceRow` against the real index. Not covered: the overview and budgets queries (the `packages/db` covering-index test pins their older shapes).
