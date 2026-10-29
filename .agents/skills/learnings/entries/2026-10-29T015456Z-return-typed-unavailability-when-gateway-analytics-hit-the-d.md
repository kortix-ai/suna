---
recorded: 2026-10-29T015456Z
incident_date: 2026-10-28
---
# Return typed unavailability when gateway analytics hit the database statement budget

**Rule:** Return 503 `analytics_unavailable` for SQLSTATE 57014 on gateway analytics GETs. Keep other database failures loud.

**Trigger surface:** Project gateway overview, series, breakdown and session analytics.

**Incident:** KRTX-3631: the 90-day overview query hit the 25-second statement timeout and returned 500. Neighboring analytics requests hit the HTTP deadline and returned 503. The frontend captured the 500 as an opaque ApiError.

**Enforcement:** `apps/api/src/__tests__/unit-gateway-statement-timeout.test.ts` exercises the installed HTTP error handler. It checks the typed response, Retry-After, no Sentry capture, and preservation of unexpected errors.
