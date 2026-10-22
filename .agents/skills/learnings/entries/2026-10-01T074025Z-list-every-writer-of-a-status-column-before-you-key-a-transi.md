---
recorded: 2026-10-01T07:40:25Z
incident_date: 2026-10-01
---
# List every writer of a status column before you key a transition on it

**Rule:** Before a decision reads a status column (push once on healthy → failed, clear on recovery), list every code path that writes that column. A path that writes a different fact (a fire, a delivery) must not overwrite the fact the decision reads. Give that fact its own column, and make the other writers keep it.

**Trigger surface:** Adding a transition, a notification, or a dedupe on a shared status column, e.g. `project_trigger_runtime.last_status` (written by `markGitTriggerFired`, `markGitTriggerAttemptFailed`, `markTriggerRuntimeDelivered`, `markTriggerRuntimeDeliveryFailed`, `recordTriggerRunEnd`).

**Incident:** 2026-10-01, dev, a near-miss. PR #8586 recorded a failed trigger run as `last_status: failed` and pushed the account owner when the status was not already `failed`. On dev, the next fire of a reuse trigger queued its prompt, and its delivery wrote `fired` over the failure 2 s later. The failure left the Schedule page, and every later failed run was a new transition with a new push. Unit and DB tests passed: each one wrote through one path only. Fixed by `run_failing_since`: a fire or delivery keeps `failed` while it is set, and only a finished run clears it.

**Enforcement:** `apps/api/src/__tests__/integration-trigger-run-outcome.test.ts` ("a re-fire and its delivery keep the failure, and the next failed run does not push again") drives the fire, delivery, and run-end writers against one real row.
