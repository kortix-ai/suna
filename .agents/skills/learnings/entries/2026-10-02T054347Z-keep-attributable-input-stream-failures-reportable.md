---
recorded: 2026-10-02T05:43:47Z
incident_date: 2026-10-02
---
# Keep attributable input-stream failures reportable

**Rule:** Keep unknown input-stream failures reportable. Missing stack frames do not establish an expected state; require independent expected-state evidence before suppressing an event.

**Trigger surface:** Changing browser network-noise rules or Sentry beforeSend.

**Incident:** 2026-10-02, KRTX-984: one Firefox global rejection had no stack. The event did not identify a failing download or session stream. Independent review rejected the proposed suppression because framelessness alone does not prove harmless transport noise.

**Enforcement:** `apps/web/src/lib/browser-error-noise.test.mts` keeps the exact frameless signature, source-attributed failures, handled events, message variants, and runtime captures reportable. The golden fixture pins the reportable verdict.
