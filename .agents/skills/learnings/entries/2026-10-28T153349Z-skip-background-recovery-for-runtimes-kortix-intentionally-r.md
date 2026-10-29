---
recorded: 2026-10-28T15:33:49Z
incident_date: 2026-10-28
---
# Skip background recovery for runtimes Kortix intentionally removed

**Rule:** Check `isKortixInitiatedRemoval` before background in-place recovery. A removed box with a teardown intent is not a recovery candidate; preserve the existing removal handling instead of asking the provider to restore it.

**Trigger surface:** The parked-runtime verification and late-start wake-maintenance paths sharing `recoverRemovedParkedRuntime`.

**Incident:** KRTX-3602: 36 production restore refusals in the 12:00–13:30 UTC window, all 404 and all correlated with expected-teardown events. The recovery helper checked only previously unavailable identities, so intentional removals reached the provider restore endpoint before being classified as expected teardown. No uptime incident occurred in the window.

**Enforcement:** `parked-runtime-verification.test.ts` exercises archived rows, account removal intent and pending provider removal through the real helper. All three fail before the guard and pass after it; ordinary recoverable removals retain their existing recovery tests.
