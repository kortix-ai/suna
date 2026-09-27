---
recorded: 2026-09-21T12:26:07Z
incident_date: 2026-09-21
commit: 5443fa54eb
---
# Exercise expensive Git setup only in the test that owns its contract

**Rule:** A shared CLI fixture must not repeat local Git pushes for cases that
only test request fields. Model a managed repository outside the branch-specific
case. **Incident:** `sessions.e2e.test.ts` repeated a local push in all 7 cases.
The second push hung for 30 seconds under package-lane load and failed every PR.
**Enforcer:** the fixture enables client-side branch creation only in the test
that asserts its remote ref; the remaining cases use managed-repository metadata.
