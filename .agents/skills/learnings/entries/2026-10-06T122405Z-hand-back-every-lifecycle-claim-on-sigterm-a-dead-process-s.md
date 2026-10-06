---
recorded: 2026-10-06T12:24:05Z
incident_date: 2026-10-06
---
# Hand back every lifecycle claim on SIGTERM; a dead process's lease blocks its session for the lock plus the grace

**Rule:** A process that holds lifecycle claims hands them back on SIGTERM. A claim's lease is reclaimable only after the 5-min lock plus the 5-min grace, and the session's next prompt waits behind it the whole time.

**Trigger surface:** `apps/api/src/bootstrap.ts` (`shutdown`), `apps/api/src/projects/session-lifecycle/claim-handover.ts`, `drain.ts` — any new path that claims `session_lifecycle_commands` rows must record its lease (`trackClaims`) and forget it when the row settles.

**Incident:** 2026-10-06, found in review, reproduced locally (branch `prompt-queue-bugs`). `shutdown()` exited with a row still `running` under the process's lease; every rollout during a cold-box wait stalled that session's prompts for up to 10 min. A worker id cannot name the process: `process.pid` is 1 in every container.

**Enforcement:** `apps/api/src/__tests__/integration-inbox-pause-and-handover.test.ts` — "its claimed prompt is released at once, not after the lock and grace" and "a delivery still running in the exiting pod does not send after the hand-back".
