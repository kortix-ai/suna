---
recorded: 2026-09-28T23:53:49Z
incident_date: 2026-09-28
---
# A background job's failure retry must back off and skip past the stuck unit

**Rule:** A periodic worker that retries a failed unit must escalate its retry
delay and advance its cursor past the unit after repeated consecutive failures.
A flat retry delay plus a cursor that never moves turns one permanently failing
unit into an unlimited hot loop. Before shipping a per-tenant predicate on a
large table, index the predicate column: an unindexed branch makes the unit
fail forever, and the loop above then amplifies it.

**Trigger surface:** any periodic worker whose tick processes one unit per pass
and retries in its catch block — reconciliation sweeps, maintenance workers,
relays. Also any ad-hoc per-account query over a multi-GB ledger table.

**Incident:** prod, 2026-09-23 through 2026-09-28. The audit-reconciliation
worker retried one large account every 5 s forever: the 8-table anti-join in
`reconcileAuditEvents` had no `account_id` index on two source tables, so every
attempt hit its 10 s statement timeout. Better Stack counted 1,600-5,300
`[audit-reconciliation] page failed` lines per day. The loop held the
2-connection audit pool and burned Postgres I/O; in the same minutes, routes
that make 6+ sequential DB round trips answered `200` in 1.2-12.7 s
(`GET /v1/accounts` p95 1.6 s against a 742 ms baseline) while p50 stayed at
50-200 ms — saturation queueing, not a defect in those routes. Fixed by
PR #7970 (two `CREATE INDEX CONCURRENTLY` migrations plus the bounded retry).

**Enforcement:** `apps/api/src/shared/audit-reconciliation-worker.test.ts`
pins the escalating delay (5s → 30s → 120s, capped 300s), the skip after 3
consecutive failures on one account, and every streak-reset rule.
