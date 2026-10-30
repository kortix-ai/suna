---
recorded: 2026-10-21T22:05:20Z
incident_date: 2026-10-21
---
# Preserve an unknown exec outcome after an upstream gateway timeout

**Rule:** Return a typed unknown outcome for an upstream exec 504. Never replay the command or advertise a retry delay.

**Trigger surface:** Handling a Platinum POST sandbox exec response at the HTTP error boundary.

**Incident:** 2026-10-21, KRTX-3036: 25 provider gateway timeouts became unhandled API 500s. A gateway timeout does not prove the command did not run.

**Enforcement:** `apps/api/src/__tests__/unit-platinum-exec-timeout.test.ts` checks the real HTTP error dispatcher, one provider call, no Retry-After, no Sentry capture, and unrelated errors staying loud.
