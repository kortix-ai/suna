---
recorded: 2026-10-14T09:13:04Z
incident_date: 2026-10-14
---
# Retry every provider refusal that means not now, inside the start budget

**Rule:** When a sandbox provider refuses a start with a code that means "not now" (host full, relocation pending), retry inside `start()` until `START_RESTORE_BUDGET_MS` runs out. Never throw on the first refusal: the caller parks the session stopped and drops the prompt that woke it.

**Trigger surface:** Changing `PlatinumProvider.start()` (`apps/api/src/platform/providers/platinum.ts`), adding a provider start path, or reading a new Platinum 503 code.

**Incident:** 2026-10-14, v0.13.57 release gate. Platinum answered `POST /v1/sandboxes/:id/start` with `503 {"code":"capacity","error":"host saturated — cannot start sandbox right now"}` when the stopped box's own host was full. `start()` retried only the three relocation codes, so it threw. `settleFailedRestart` logged `restart-in-place failed — session parked stopped`. Browser journeys 30 and 13 failed in 3 of 5 gate attempts. Prod logged 4 such refusals in 90 minutes; those users stayed on "Starting this session's computer…". Fixed in #9823: `capacity` joined `START_RETRY_CODES`.

**Enforcement:** `apps/api/src/platform/providers/platinum-start-restore.test.ts` — "a host-saturated 503 is retried until the host has room".
