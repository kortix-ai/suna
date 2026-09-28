---
recorded: 2026-09-26T10:52:24Z
incident_date: 2026-09-26
---
# Derive future test claim times from the current clock

**Rule:** Derive a test's future claim time from `Date.now()` when the test inserts
rows at the current time. Keep it after any fixed retry dates too.

**Trigger surface:** Tests that pass an explicit `now` to a queue claim or scheduler.

**Incident:** On 2026-09-26, the `main` core lane failed four lifecycle lease
cases after their fixed claim time, 10:00 UTC, passed. The PR checks ran before
10:00 UTC and passed. Two `main` runs failed on the same merge commit.

**Enforcement:** `integration-lifecycle-command-lease.test.ts` claims after both
the current clock and its fixed retry clock. The four cases passed locally
after the fixed claim time.
