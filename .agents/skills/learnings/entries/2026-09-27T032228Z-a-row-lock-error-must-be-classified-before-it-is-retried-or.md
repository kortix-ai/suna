---
recorded: 2026-09-27T03:22:28Z
incident_date: 2026-09-24
---
# A row lock error must be classified before it is retried or dropped — never dead-letter contention

**Rule:** A write's `catch` must run the error through a contention classifier
(`isAuditContentionError` / the SQLSTATE allowlist: 55P03, 57014, 40001,
40P01, the 08xxx/57Pxx "database went away" codes, and the driver's own
connection codes) before deciding what to do with the batch. Contention means
another writer holds what this one needs — it is backpressure, and the batch
must be requeued with bounded exponential backoff, never dropped and never
counted as a defect. Only a batch that fails for a reason the classifier does
not recognize (a real data error: a constraint, a bad value) may be
dead-lettered, and that must be logged loudly with its row count. A background
flusher that dead-letters on ANY exception, with no classification step at
all, silently discards 100% of a lock-contention incident and reports 0% of it
as a defect.

**Trigger surface:** Writing or reviewing a batched/background writer's error
handling for `kortix.audit_events`, or any other table whose insert trigger
takes a per-key row lock held to COMMIT. Also applies to reviewing a "queue
drop" or "batch dropped" log line: before treating it as expected best-effort
loss, check what SQLSTATE it carries.

**Incident:** `AuditQueue.write()` (`apps/api/src/shared/audit-queue.ts`)
caught every write failure with one branch: log it, count it as `failed`, and
discard the batch. `audit-db.ts` already had `isAuditContentionError` — built
for the SAME `audit_session_sequences` row-lock contention, used correctly by
the synchronous ingest route (`project-audit.ts`, which answers a retryable
503) — but the queue's flush path never called it. Prod, 2026-09-24 through
2026-09-27: hundreds of `[audit] Dropped a batch of N events after a write
failure: sqlstate=55P03 canceling statement due to lock timeout` per hour
(peak 843/hour), 100% lock-timeout contention, 0% a real data defect, every
one of them a silently discarded audit-trail row. The prior in-process fix
(same-session serialization between the ingest route and this same queue)
narrowed the contention window but could not eliminate it: separate API
replicas still hold the same session's sequence row from different Postgres
backends, and that stays true after this fix — only the classify-then-drop
step changed.

**Enforcement:** `apps/api/src/shared/audit-queue.test.ts`, describe block
"AuditQueue never drops a contended batch": every documented contention
SQLSTATE (57014/55P03/40001/40P01/57P03/08006/53300) and a driver-level
connection code are asserted to requeue instead of dead-letter, a genuine data
error (23505) is asserted to still dead-letter exactly once, and a
"backs off exponentially instead of retrying every flushMs" case pins the
backoff. `apps/api/src/shared/error-cause.test.ts` and `audit-db.test.ts`
already pinned the classifier itself; it now lives in the dependency-free
`error-cause.ts` (moved from `audit-db.ts`, which imports the live `db` pool)
so the flush path can call it directly without breaking its own
database-free tests.
