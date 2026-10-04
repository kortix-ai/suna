---
recorded: 2026-09-29T01:29:45Z
incident_date: 2026-09-29
---
# Classify a provider stop-confirm timeout in a transitional state as a lifecycle transition, not a failure

**Rule:** A `stop()` that times out while the provider still reports a transitional
state (`stopping`) is the lifecycle transition itself, not a refused stop. Classify
it with `isLifecycleTransitionInProgress` so the reaper retries without an error page
and a manual stop reconciles instead of 502ing. Only a last state of `running` (the
stop did not take) stays a genuine failure.

**Trigger surface:** Writing or reviewing a sandbox provider adapter's `stop()` and
the callers that classify its errors — `apps/api/src/services/sandboxes/reaping/stop-box.ts`
and `apps/api/src/services/sessions/lifecycle/stop.ts`.

**Incident:** 2026-09-29, PR #7807's stop-confirm bound is 10s; Platinum's own
`stopping` transition outlasts it (the same transition `MIDTURN_STOP_CONFIRMATION_MS`
documents at 60s). 258 `did not reach stopped` failures over 48h, 242 of them
`last state: stopping`; a routine idle-reap cohort emitted one `console.error` per box,
a 5.5x error-log spike (KRTX-667). The same classification gap also returned HTTP 502
to a user's manual Stop while the box was still powering off.

**Enforcement:** `apps/api/src/services/sandboxes/reaping/stop-box.test.ts` (stopping timeout is
`skipped`, no error log; running timeout stays `errors`) and
`apps/api/src/services/sessions/lifecycle/__tests__/stop.test.ts` (stopping timeout
commits the stop at 200).
