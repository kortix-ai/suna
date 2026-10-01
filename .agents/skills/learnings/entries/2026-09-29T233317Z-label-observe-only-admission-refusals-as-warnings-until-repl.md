---
recorded: 2026-09-29T23:33:17Z
incident_date: 2026-09-29
---
# Label observe-only admission refusals as warnings until replacement is enabled

**Rule:** Match the severity and message of an admission refusal to `RUNTIME_ADMISSION_ENFORCE`. When disabled, report a warning that the box remains in use; only claim replacement when enabled.

**Trigger surface:** Logging the result of `admitRunningSandbox` during a session open.

**Incident:** On 2026-09-29, old running boxes without `config.release.v1` produced error-level "box replaced" logs even though the kill switch kept the box serving. This created a new error-pattern spike without a matching start-route 5xx spike.

**Enforcement:** `apps/api/src/runtime-convergence/__tests__/admit-running-sandbox.test.ts` checks both enforcement modes and their severity and wording.
