---
recorded: 2026-09-30T11:55:16Z
incident_date: 2026-09-30
---
# Turn a provider wake switch off before you stop the box, and backfill boxes that already sleep

**Rule:** In a provider `stop()`, turn off the provider's own wake-on-request switch (Platinum `auto_resume`) BEFORE the stop call, never after it. When the switch ships, backfill every box that already sleeps: the next stop never comes for a box that is already stopped or archived.

**Trigger surface:** Changing `PlatinumProvider.stop()`, any provider lifecycle flag, or adding a provider feature that can start a box without the control plane.

**Incident:** 2026-09-30, a self-host still on v0.13.39. The idle reaper stopped a session box. 34 s later a stray request through the edge auto-resumed it, and the row stayed `stopped`. The token was dead, so the old daemon exited 0 and nothing listened on :8000 for 53 min. Every `/start` resumed the same corpse. A later stop was resumed 1.3 s after `stop.done`, which beats the PATCH-after-confirm in #8277. 500 older session boxes still had `autoResume: true`; they were backfilled by hand.

**Enforcement:** `apps/api/src/platform/providers/platinum-stop-confirm.test.ts` "stop() turns auto-resume off before it asks Platinum to stop" asserts the order `patch`, `stop`. The backfill has no enforcer. To build one: a divergence-sweep check that counts session boxes with `autoResume: true`.
