---
recorded: 2026-10-11T04:40:25Z
incident_date: 2026-10-11
---
# Cap the holders of any lock transaction whose body queries the shared pool below the smallest DB_POOL_MAX

**Rule:** A lock transaction (`db.transaction` + `pg_advisory_xact_lock` or `pg_try_advisory_xact_lock`) pins one pooled connection for its whole body. When the body queries the shared `db` instead of its `tx`, it needs a second connection from the same pool. Take a slot from `createHolderSlots` (`apps/api/src/shared/holder-slots.ts`) before the transaction. Keep the caps of all such locks together below the smallest deployed `DB_POOL_MAX` (staging: 4, `deploy-staging.yml`). Otherwise, run the whole body on `tx`.

**Trigger surface:** Adding a lock transaction that a sweep, a worker or a burst of requests can enter for several keys at once. The connector sweep reconciles 6 projects in parallel (`connectorProjectConcurrency()`).

**Incident:** 2026-10-11, release PR #9531 (v0.13.54), lock from #9390. `withProjectEventLock` had no cap. About 4 min after the staging deploy, the sweep put 4 holders on the leader API task, whose pool is 4. Each held a connection `idle in transaction` and waited for a fifth. Every request routed to that task waited 55 s and returned `503 request_deadline`, about 1 in 6 to 1 in 3 of all staging requests. `/health` (no DB) stayed green, so the deploy passed. The `tests-release` gate failed on 3 runs of one shard. Terminating the 4 backends cleared it for 40 s, and the next sweep deadlocked again. Production never ran the code. Unit tests and the local stack passed, because a 2-task dev with pool 6 and few event triggers rarely reaches 6 holders.

**Enforcement:** `apps/api/src/projects/trigger-events/store.integration.test.ts` (`pnpm test`, `db-suites` lane). "a burst of locks across projects never exhausts the request pool" runs 2 × `DB_POOL_MAX` locks against real PostgreSQL and fails when they stall for 10 s. "every pinned-connection lock together stays below the smallest deployed pool" reads `DB_POOL_MAX` from `deploy-staging.yml` and sums the billing and event caps. A new lock of this shape is not detected: add its cap to that sum. Diagnose a live case with `select state, query, now()-xact_start from pg_stat_activity where state = 'idle in transaction'`.
