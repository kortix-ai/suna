---
recorded: 2026-09-26T11:22:16Z
incident_date: 2026-09-26
---
# Serialise same-session audit writes in-process before they reach a row lock held to commit

**Rule:** When two code paths in ONE process can write rows that take the same
per-key row lock held to COMMIT, serialise them in memory (a per-key async mutex)
before either reaches the database. Never let two in-process writers race a
`SELECT … FOR UPDATE`-style lock, because the loser is cut off by `lock_timeout`
and its work is discarded, while the winner can still ride to `statement_timeout`.

**Trigger surface:** Adding or touching any writer of `kortix.audit_events`
(the sandbox audit ingest route, the audit queue, `runAuditedTransaction`), or
any other table whose trigger takes a per-key lock in a `BEFORE INSERT`.

**Incident:** 2026-09-26 prod. `POST
/v1/projects/:id/sessions/:id/audit/events` returned 491 5xx in 60 min — every
one of them the route's own `[audit] ingest contended` 503 with SQLSTATE `57014`
(statement timeout, ~10 s). In the same window the audit queue logged 632
`[audit] Dropped a batch … sqlstate=55P03 canceling statement due to lock
timeout`. Both writers are the same API process and the same `sessionId`:
`kortix.audit_prepare_event` locks that session's `audit_session_sequences` row
until the statement's COMMIT, and the ingest route's chunk raced the request's
own inbound audit row, which `sessionIdForSnapshot` stamps with the path session
id. The queue lost the race at its 2.5 s `lock_timeout` and dropped the row; the
ingest rode its 10 s `statement_timeout`. The rate was INVERSE to traffic — a
per-session livelock, not aggregate load (hours with ~11,000 requests had <100
5xx; hours with <3,000 had >300). Fixed by serialising both writers on a
process-local per-session mutex (`apps/api/src/shared/audit-session-serial.ts`),
so the second writer waits in memory and then inserts uncontended.

**Enforcement:** `apps/api/src/shared/audit-session-serial.test.ts` (same session
serialises, different sessions do not, a timed-out waiter does not wedge the
queue, every gate is freed) and the `AuditQueue per-session serialization` block
in `apps/api/src/shared/audit-queue.test.ts`, which fails if a queue flush opens
a competing insert while another in-process writer holds the session lock.
Not yet covered: `runAuditedTransaction`'s synchronous insert, and the
cross-replica race between two API tasks — the latter still needs the database's
`lock_timeout` as the backstop.
