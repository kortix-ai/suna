---
recorded: 2026-10-09T10:01:52Z
incident_date: 2026-10-06
---
# Raise one database pool at a time inside the rolling-fleet budget, then re-check the connection-wait share on prod

**Rule:** Before raising any pool constant in
`apps/api/src/shared/database-capacity.ts` or
`packages/db/src/connection-defaults.ts`, recompute the rolling-deployment
ceiling (tasks × rolling overlap × every counted pool) and keep it at or below
`PROD_DB_USABLE_CONNECTIONS - PROD_DB_NON_API_RESERVE` (205 of 237). Raise ONE
pool by ONE step per change. Fund the raise inside the envelope — a transient
boot client (the schema drift probe rode its own client until 2026-10-09) or a
counted pool you no longer need. After each deploy, re-check on prod before the
next raise: per-statement wall time from the request logs
(`db;dur` ÷ `desc="n=…"` on the slow tail) against the server-side exec from
pg_stat_statements; the gap is the connection-wait share. It must drop, and
SQLSTATE `53300` must stay at zero, before the next step.

**Trigger surface:** changing `DEFAULT_DB_POOL_MAX`, `DEFAULT_AUDIT_POOL_MAX`,
`LEADER_ELECTION_POOL_MAX`, `PG_BROADCAST_POOL_MAX`, the non-API reserve, ECS
task capacity, `deployment_maximum_percent`, or the Postgres instance size.

**Incident:** 2026-10-06→09, prod. `GET /v1/projects/:id/sessions/:id` p95 rose
from 308 ms to 1054 ms (KRTX-532). The request's statements are cheap —
~2.49 ms server-side exec p50 — but the request wants ~9.4 concurrent
statements while every pool caps at 5, so ~98% of statement wall time on the
slow tail was pool wait (measured 2026-10-07→09: per-statement wall p50
225–242 ms, p95 745–891 ms against ~2.5 ms exec). PR #9437 (in review) cuts the
fan-out from 64 to ~6 statements per request; KRTX-2020 raises the request pool
5→6 with the headroom freed by folding the boot schema probe into the request
pool (ceiling 190 → 200 ≤ 205, buffer 15 → 5). The next raise (6→7, 210 > 205)
does not fit: it needs the infra lane first — a larger Postgres compute, a
smaller rolling overlap in Terraform, or the transaction-mode pooler.

**Enforcement:** `apps/api/src/shared/database-capacity.test.ts` recomputes the
ceiling from the pins and fails when the invariant breaks; its probe test fails
if `ensure-schema.ts` opens its own postgres client again. The re-check query
(lane: Better Stack ClickHouse `t502678.kortix_api_logs*`, aggregate only):
`quantile(0.5)(extract(server_timing,'db;dur=([0-9]+)') / extract(server_timing,'db;dur=[0-9]+;desc="n=([0-9]+)"'))`
on status-200 `GET /v1/projects/:id/sessions/:id` rows carrying `db;dur=`,
per day, against the pg_stat_statements exec p50 from the Supabase collector.
