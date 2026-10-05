---
recorded: 2026-08-26T13:06:00Z
incident_date: 2026-08-26
commit: 97b81a45d1
---
# A row lock held to COMMIT makes batch size a blast radius, and a 500 turns backpressure into a livelock

**When:** writing anything that inserts into `kortix.audit_events`, sizing an
audit batch, or triaging `insert into "kortix"."audit_events"` blocking another
one in `pg_stat_activity`.
`kortix.audit_prepare_event` allocates the per-session sequence and hash-chain
head from `kortix.audit_session_sequences`; PostgreSQL holds that row lock until
the inserting transaction COMMITs. So the lock is held for the WHOLE statement,
not the allocation: one 200-row ingest pinned a session for its full duration and
one 100-row queue flush built in arrival order pinned up to 100 sessions at once.
Rules: (1) one statement never spans two sessions; (2) chunk a batch so the lock
is held per chunk and committed chunks survive a later failure; (3) give the
audit pool a `lock_timeout` far below its `statement_timeout` — a lock wait is
not work; (4) report contention (57014/55P03/40001/40P01) as a retryable 503 with
`Retry-After`, never a 500, and back the client off exponentially.
*Incident:* SampleCo self-host 2026-08-26 — `POST …/audit/events` returned
500 [57014] 445 times in 3h, each at ~10s, while the sandbox relay's flat 1s
retry re-entered the same lock queue and kept the convoy alive. Predecessor:
PR #6702's dedicated audit pool isolated the damage but did not remove it.
*Enforcer:* `statementBatches` + its tests (`apps/api/src/shared/audit-queue.ts`),
`isAuditContentionError` tests (`apps/api/src/shared/audit-db.test.ts`), the
per-session lock-scope integration test in
`packages/db/scripts/centralized-audit-v2.integration.test.ts`.
