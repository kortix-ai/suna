---
recorded: 2026-09-29T01:45:57Z
incident_date: 2026-09-28
---
# Bound every default-on background writer that holds a request-path pool slot

**Rule:** A background writer that can run per user action (per turn, per wake, per
open) and holds a connection from the request-path pool must have a process-wide
concurrency bound from its first default-on day. Queue the waits in memory, never
on a pooled backend. If it must share the main pool, cap it at
`DEFAULT_AUDIT_POOL_MAX` (2) or less; if it needs its own pool, update
`shared/database-capacity.ts` and its invariant test in the same PR.

**Trigger surface:** shipping or flipping a feature that writes from a
fire-and-forget call site (`void`-ed captures, wake hooks, relays) — any writer
invoked more often than a human clicks. Check before the flag's `platformDefault`
goes `true`, not after the pager fires.

**Incident:** 2026-09-28, promote 290 shipped `session_transcript_history`
default-on (#7853). From 13:00 UTC every turn end and wake fired an unbounded
transcript capture that read the session's whole stored history (1:1 tool
payloads, up to 500 rows × ~1 MB) off the shared pool before its write
transaction. Concurrent captures pinned all `DEFAULT_DB_POOL_MAX` (5) slots per
task: the 25 s request-deadline guard went from ~0–6 to 100–600 503s/h (burst
1988/h), audit ingest collapsed from ~6k to ~150 req/h (p50 10 s, 63% 5xx), and
every multi-query route tripled at p95 (one connector route: 2822 → 7576 ms).
p50 stayed flat the whole time — reads were fine, the pool queue was not.

**Enforcement:** `apps/api/src/__tests__/integration-session-transcript-capture.test.ts`
"background captures queue behind the slot gate and a tail capture bypasses it"
(DB suite; runs in the `db-suites` lane). It fails when background captures can
run past `TRANSCRIPT_CAPTURE_MAX_CONCURRENT` or when a `scope: 'tail'` capture
queues. The generic rule for other writers is none yet: a lint or unit gate that
fails when a `void`-ed module-level writer's DB client has no concurrency cap.
