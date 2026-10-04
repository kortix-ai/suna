---
recorded: 2026-09-27T07:12:28Z
incident_date: 2026-09-27
---
# Count every always-on LISTEN/NOTIFY connection in the rolling-deployment DB budget

**Rule:** Every connection a process opens and never releases — a request
pool, an audit pool, a leader-election client, or a `sql.listen()`
subscription — is a long-lived, per-task connection. Add its `max` to
`apps/api/src/lib/database-capacity.ts`'s rolling-deployment ceiling in the
SAME change that introduces it, before merge, not after an incident finds it.

**Trigger surface:** Adding any `postgres(databaseUrl, { max: N, ... })` call
that is created once (module scope, or awaited once at boot) and kept open —
especially a `sql.listen()` subscription, which by design takes a connection
out of the pool for the connection's whole lifetime.

**Incident:** `apps/api/src/lib/pg-broadcast.ts` (`startConfigBaseMoveBroadcast`,
introduced #7699, 2026-09-26 17:11 CEST) opens a dedicated `max: 1`,
`idle_timeout: 0` LISTEN connection, awaited unconditionally on EVERY replica
at boot — not leader-gated, never released. `database-capacity.ts` counted the
main pool, the audit pool, the leader-election connection, and the schema
probe, but not this one. The 2026-08-22 budget had exactly 15 slots of spare
rolling-deployment headroom; this connection alone costs
`PROD_API_MAX_TASKS * ROLLING_TASK_OVERLAP = 20` slots at the rolling peak,
5 over that headroom. Production hit SQLSTATE `53300` on `POST
.../sessions/:id/start`, `.../stop`, `GET .../sessions/:id`, and `POST
/internal/gateway/models` during the v0.13.35 rollout: 138, 152, and 22
occurrences at 06:47, 06:48, and 06:49 UTC on 2026-09-27, then 0 once the
rollout finished. Daily counts climbed 10 → 14 → 34 → 92 → 63 → 44 → 58 from
2026-09-20 through 2026-09-26 as normal deploys ran ever closer to the
now-5-over ceiling; only the widest overlap window (this rollout) tipped it
over enough to be visible as a burst.

**Enforcement:** `apps/api/src/lib/database-capacity.test.ts` now pins
`PG_BROADCAST_POOL_MAX` (1) and asserts `pg-broadcast.ts` imports it instead of
a literal `max: 1`, so a future always-on connection added the same way
without updating the budget fails this test immediately. Fixed by folding the
missing connection into the existing 9-per-task budget instead of raising it:
`DEFAULT_DB_POOL_MAX` (`packages/db/src/connection-defaults.ts`) dropped from
6 to 5, keeping `PROD_DB_ROLLING_CONNECTION_CEILING` at 190 — no terraform
change, no capacity increase, same headroom the 2026-08-22 budget always had.
