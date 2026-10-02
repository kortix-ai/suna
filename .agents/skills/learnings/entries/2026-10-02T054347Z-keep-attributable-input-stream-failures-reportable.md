---
recorded: 2026-10-02T05:43:47Z
incident_date: 2026-10-02
---
# Keep attributable input-stream failures reportable

**Rule:** Classify only the exact input-stream global rejection with no resolvable source as non-paging. Keep handled and attributable failures reportable.

**Trigger surface:** Changing browser network-noise rules or Sentry beforeSend.

**Incident:** 2026-10-02, KRTX-984: one Firefox global rejection had no stack. The event did not identify a failing download or session stream. Reuse the evidence-aware gate instead of suppressing the message globally.

**Enforcement:** `apps/web/src/lib/browser-error-noise.test.mts` covers the exact signature, source frames, handled events, message variants, and runtime preservation. `browser-noise/rules.test.ts` enforces golden fixture coverage.
