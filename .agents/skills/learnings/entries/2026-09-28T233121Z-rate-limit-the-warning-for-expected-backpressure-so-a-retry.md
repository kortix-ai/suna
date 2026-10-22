---
recorded: 2026-09-28T23:31:21Z
incident_date: 2026-09-28
---
# Rate-limit the warning for expected backpressure so a retry does not become a new log-pattern spike

**Rule:** When a code path retries a condition it deliberately treats as
expected backpressure (a lock wait, a busy resource), rate-limit its warning
the same way its drop/failure warning is rate-limited: report the FIRST
occurrence, then at most one line per interval. Never emit one warning per
retry attempt. A retired warning's replacement text is a NEW log pattern, so it
starts a fresh baseline and reads as a spike even when nothing got worse.

**Trigger surface:** Any change to `AuditQueue.write()`'s contention branch
(`apps/api/src/shared/audit-queue.ts`), or any retry/backoff loop that calls a
warn/error hook per attempt.

**Incident:** 2026-09-28 prod. PR #7805 replaced the throttled
`[audit] Dropped a batch …` warning with an unthrottled
`[audit] Write contended — requeuing N events for retry #N …`, one line per
retry attempt. The underlying per-session `audit_prepare_event` row-lock
contention was unchanged and harmless (`dropped` stayed 0: the requeue path
loses no rows). ClickHouse showed 8,528 lines that day against a 26-line/24 h
baseline, and the new pattern was filed as a warn-log spike (KRTX-614). Fixed
by throttling the contention warning to one line per 60 s, first occurrence
always reported, `stats().contended` still counting every requeued row.

**Enforcement:** `apps/api/src/shared/audit-queue.test.ts` →
`contention warnings are rate-limited to one per interval, without losing the
accounting`, which sees five warnings without the throttle and one with it.
