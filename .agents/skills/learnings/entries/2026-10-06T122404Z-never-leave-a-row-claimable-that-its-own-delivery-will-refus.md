---
recorded: 2026-10-06T12:24:04Z
incident_date: 2026-10-06
---
# Never leave a row claimable that its own delivery will refuse; a give-back that refunds the attempt has no exit

**Rule:** Never leave a row claimable that its own delivery will refuse. A give-back refunds the attempt, so the dead-letter budget never ends that loop: either the claim skips the row, or the give-back makes it not due.

**Trigger surface:** `apps/api/src/projects/session-lifecycle/` — `command-claims.ts` (`claimDueLifecycleCommands`), `inbox-delivery-hold.ts`, and any writer that puts a `held` row back to `queued` (paused give-back, `parkPromptForUnreachableRuntime`, `requeueForAdmission`, instance release).

**Incident:** 2026-10-06, found in review, reproduced locally (branch `prompt-queue-bugs`). Stop pressed during a delivery left the row `held` and due now; the claim ignored `held`, the pre-POST check threw, and the give-back refunded the attempt. About 8 cycles per 10 s on one row, with no log line, and the session read `running` with no box. Same class as the 2026-09-29 interrupt-arm loop.

**Enforcement:** `apps/api/src/__tests__/integration-inbox-pause-and-handover.test.ts` — "the paused prompt stays out of the drain until the hold is lifted" and "a held prompt past its 24 h due time is still not claimed"; both fail without the fix.
