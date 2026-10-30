# Session speed: denominator audit (KRTX-3686)

No latency improvement is claimed. Dashboard 1165815 is latency evidence, not a complete reliability population. Always freeze `[start,end)` and an observation cutoff in UTC; never compare two independently evaluated `now` windows. Record the deployed `/v1/health` commit separately from the bench checkout SHA. Schema-2 canary fields apply only after that checkout runs; they do not backfill old events.

## Populations and limits

- Canary: one emitted terminal observation per synthetic session run. An interrupted runner or failed ingestion has no row and is **unobserved**, not successful. Reconcile expected scheduled runs separately. Schema 1 has `canary_ok`, but no structured timeout; timeout rate is unavailable for it. Schema 2 distinguishes succeeded, failed, timeout, unknown. Failure rate includes timeouts; unknown is reported separately and remains in the observed denominator.
- Production boot: `kortix.session_lifecycle_commands`, `command_type='create_session'`, one durable command, not each retry or HTTP call. `succeeded` means command completed, NOT runtime-ready or first-token success. Queued/running are pending/unknown at cutoff. Terminal `failed`/`dead_lettered` are failures. There is no structured boot timeout code; timeout count/rate are **unavailable**, not zero. Session boot readiness and all HTTP attempts are not a complete population in this ledger.
- Production prompt: `kortix.gateway_request_logs`, one recorded terminal gateway request, not a user turn and not each fallback attempt. `ok=false` is failed; `error_code='upstream_timeout'` is a structured upstream timeout. Not every pipeline rejection or process crash necessarily persists a row, so this is **recorded gateway outcomes**, never all user prompts. Provider and resolved model are supported. Sandbox provider is a different dimension from gateway provider.
- Resume and region: **unavailable** in these speed cohorts. Do not infer resume from warm timings, provider from chart titles, or region from a host. Boot command source is supported, not boot provider. Canary provider/harness are response fields (provider falls back to explicit bench configuration); no customer IDs, prompts, output text or error strings enter the shipped event.

## Production aggregate SQL (PostgreSQL, read only)

Run in one read-only REPEATABLE READ transaction at cutoff, record its timestamp. `$1`/`$2` are fixed UTC start/end. This is a current snapshot, not historical reconstruction at an earlier cutoff: command rows mutate. Keep retries inside their original command denominator.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT transaction_timestamp() AS observation_cutoff;
SELECT source, count(*) AS attempts,
 count(*) FILTER (WHERE status IN ('failed','dead_lettered')) AS failures,
 count(*) FILTER (WHERE status='succeeded') AS completed_commands,
 count(*) FILTER (WHERE status IN ('queued','running')) AS pending_unknown,
 NULL::bigint AS timeouts,
 100.0 * count(*) FILTER (WHERE status IN ('failed','dead_lettered')) / NULLIF(count(*),0) AS failure_pct,
 NULL::numeric AS timeout_pct
FROM kortix.session_lifecycle_commands
WHERE command_type='create_session' AND created_at >= $1 AND created_at < $2
GROUP BY source;

SELECT provider, resolved_model, count(*) AS attempts,
 count(*) FILTER (WHERE NOT ok) AS failures,
 count(*) FILTER (WHERE NOT ok AND error_code='upstream_timeout') AS timeouts,
 100.0 * count(*) FILTER (WHERE NOT ok) / NULLIF(count(*),0) AS failure_pct,
 100.0 * count(*) FILTER (WHERE NOT ok AND error_code='upstream_timeout') / NULLIF(count(*),0) AS timeout_pct
FROM kortix.gateway_request_logs
WHERE created_at >= $1 AND created_at < $2
GROUP BY provider,resolved_model;
COMMIT;
```

No new production writes or parallel collector are needed. These SQL aggregates deliberately return no identifiers or request/response payloads.

## Canary raw aggregate (ClickHouse)

Use the source API v2 to confirm table names. The hot/S3 boundary prevents double counting. Filter target consistently; `dt` is run start, not terminal observation time. Query at a recorded cutoff after allowing the boot/turn deadlines and ingestion lag. A missing scheduled run is a coverage gap outside this observed population.

```sql
WITH src AS (
 SELECT dt,raw FROM remote(t502678_kortix_session_speed_canary_logs)
 UNION ALL
 SELECT dt,raw FROM s3Cluster(primary,t502678_kortix_session_speed_canary_s3)
 WHERE _row_type=1 AND dt < (SELECT min(dt) FROM remote(t502678_kortix_session_speed_canary_logs))
)
SELECT JSONExtractString(raw,'canary_target') AS target,
 count() AS observations,
 countIf(JSONExtractInt(raw,'canary_schema')=2) AS classified_observations,
 countIf(JSONExtractInt(raw,'canary_schema')!=2) AS legacy_unknown_classification,
 countIf(JSONExtractInt(raw,'canary_schema')=2 AND JSONExtractString(raw,'canary_outcome') IN ('failed','timeout')) AS failures,
 countIf(JSONExtractInt(raw,'canary_schema')=2 AND JSONExtractString(raw,'canary_outcome')='timeout') AS timeouts,
 countIf(JSONExtractInt(raw,'canary_schema')=2 AND JSONExtractString(raw,'canary_outcome')='unknown') AS unknown,
 100.0*failures/nullIf(classified_observations,0) AS failure_pct,
 100.0*timeouts/nullIf(classified_observations,0) AS timeout_pct
FROM src
WHERE dt >= {start:DateTime} AND dt < {end:DateTime}
GROUP BY target;
```

For schema-2 boot outcomes replace `canary_outcome` with `canary_boot_outcome`. Cohort comparisons must additionally group by schema-2 `canary_provider` and `canary_harness`; do not mix legacy rows lacking them. Never parse free-text errors to backfill timeout counts.

## Chart weight reconciliation

Retrieved dashboard and metric definitions with `GET /api/v2/dashboards/1165815`, `/charts/<id>`, `/sources/<id>/metrics`. Canary percentile charts use numeric labels with `sum(logs_count)` weights, so their denominator is **non-null timing observations**, not attempts. Reproduce a chart's inner query unchanged and sum `c` after `b IS NOT NULL`; compare to raw `countIf(isNotNull(JSONExtract(raw,'canary_ready_ms','Nullable(Float64)')))` (or cold/warm field). Do not count numeric buckets as samples.

Fixed prod window `2026-10-29 14:49:35 <= dt < 2026-10-29 20:49:35 UTC`, queried 2026-10-29 around 21:00 UTC: raw observations 6, failures (`canary_ok=false`) 0; ready/cold/warm non-null samples each 6. Historical timeout count unavailable. Hot-only query returned 1: it is not the six-hour denominator. Hot+S3 returned 6. Live metric query `SELECT sum(c) FROM (SELECT toFloat64OrNull(label('canary_ready_ms')) AS b,sum(logs_count) AS c FROM remote(t502678_kortix_session_speed_canary_metrics) WHERE dt >= '2026-10-29 14:49:35' AND dt < '2026-10-29 20:49:35' AND label('canary_target')='prod' GROUP BY b) WHERE b IS NOT NULL` returned **6**, matching the raw ready count **6**. This metrics table covers the fixed window (unlike the hot logs). Chart metric weight comparison must use those same bounds and target; stage metric weights cannot stand in for production command/gateway outcomes. Existing boot/provision/delivery/gateway metric expressions select timing log lines, with no terminal failure denominator.

## Deployment verification (KRTX-3685 owns follow-up)

Record runner checkout and deployed API SHA, fixed bounds and cutoff. Compare raw classified count against expected scheduled runs, then raw non-null timing counts against chart weights. Publish boot-command and recorded-gateway aggregates separately, including unknown and unavailable counts. Keep setup status until matched post-deploy coverage exists; do not call an absence of failures a production speed win.
