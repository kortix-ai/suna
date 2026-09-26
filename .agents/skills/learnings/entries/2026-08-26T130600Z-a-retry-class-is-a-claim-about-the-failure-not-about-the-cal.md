---
recorded: 2026-08-26T13:06:00Z
incident_date: 2026-08-26
commit: 97b81a45d1
---
# A retry class is a claim about the FAILURE, not about the call that returned it

**When:** writing or reviewing any `retryable = <outcome> === …` line on a
delivery/queue path. `executeQueuedContinue` derived retryability from one
outcome value, and every producer of that value — a stopped box, a parked
session, a dead resolved target — was a DOWN RUNTIME, not a bad message. A
queued prompt delivered while its box was unreachable went `dead_lettered` on
attempt 1 (`state:failed, attempts:1, last_error:"delivery outcome: failed"`)
and was never re-tried when the box returned minutes later. Rule: **name the
unreachable-runtime class separately from the refusal class, keep the work
queued with a runtime-scaled backoff, spend no dead-letter budget on it, and
re-arm it on the event you are actually waiting for.** *Enforcer:*
`deliver.test.ts` (stopped/parked → `unreachable`, missing → `no-session`) and
`integration-lifecycle-command-lease.test.ts` (bounded budget, backoff ladder,
fresh idempotency key, Stop survives as a hold, re-arm skips a held row).
