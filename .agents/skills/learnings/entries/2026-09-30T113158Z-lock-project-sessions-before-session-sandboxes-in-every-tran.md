---
recorded: 2026-09-30T11:31:58Z
incident_date: 2026-09-30
---
# Lock project_sessions before session_sandboxes in every transaction that writes both

**Rule:** In any transaction that writes both `project_sessions` and `session_sandboxes`, update the session row first, then the sandbox row (the `transitionRuntime` order). Never the reverse.

**Trigger surface:** Adding or editing a `db.transaction` that touches both tables: stop, park, wake, resume, restart, reaper writes.

**Incident:** 2026-09-30, v0.13.43: 9 manual `POST .../stop` calls answered 500 with SQLSTATE 40P01 between 03:11Z and 10:22Z. `applyStoppedState` locked sandbox then session; `transitionRuntime` (wake) locked session then sandbox. Fixed in this PR; `applyStoppedState` also retries a deadlock victim twice.

**Enforcement:** `apps/api/src/__tests__/integration-stop-lock-order.test.ts` races a stop against a wake on real PostgreSQL and fails on a deadlock. Other writers are not covered by a generic lint.
