---
recorded: 2026-08-22T13:47:00Z
commit: fff09446e2
---
# Size database pools for the rolling fleet, not the steady fleet

2026-08-22. A production API deployment overlapped 10 old ECS tasks with 10 new
tasks. PostgreSQL returned SQLSTATE `53300` because the tasks could request more
connections than the server exposed. Authorization, audit ingestion, project
reads, turn streams, webhooks, and lifecycle settlement then failed together.
The queries were collateral failures. They were not six separate defects.

**The arithmetic that failed.** PostgreSQL exposed 240 connections and reserved
3 for superusers. Each task allowed 15 main-pool connections, 3 audit-pool
connections, and 1 leader-election connection. Twenty overlapping tasks could
therefore request 380 long-lived connections against 237 usable slots. The old
comment counted only 10 steady-state main pools. It excluded the rolling overlap
and every secondary pool.

**The rule.** Bound connections against the maximum rolling fleet. Count every
long-lived pool and every concurrent startup probe. Reserve explicit capacity
for Supabase, operators, migrations, and request-scoped clients. A steady-state
calculation is invalid for a service with `deployment_maximum_percent = 200`.

**The enforcement.** `apps/api/src/shared/database-capacity.test.ts` pins the
production server limit, ECS maximum capacity, rolling overlap, main pool,
audit pool, leader connection, startup probe, and non-API reserve. The test
fails when the API connection ceiling exceeds the available application budget.
Any change to pool size, task capacity, deployment overlap, or PostgreSQL size
must update and pass this invariant before deployment.

*Incident:* production, SQLSTATE `53300` from 01:15:10Z through 01:16:37Z.
Verification that settles it: deploy the bounded pools, confirm the exact
production SHA, exercise webhook and session traffic, then query Better Stack
for zero new SQLSTATE `53300` occurrences after the rollout completed.
