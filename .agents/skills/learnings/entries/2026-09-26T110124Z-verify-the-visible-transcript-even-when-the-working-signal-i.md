---
recorded: 2026-09-26T11:01:24Z
incident_date: 2026-09-26
---
# Verify the visible transcript even when the working signal is absent

**Rule:** Reconcile the visible session transcript on terminal stream events. Verify its tail periodically while the session page is open, even when the working projection says idle.

**Trigger surface:** Changing session message sync, working-state projection, or stream lifecycle handling in `@kortix/sdk`.

**Incident:** On 2026-09-26, an automated session completed in its terminal while the browser transcript stayed on earlier messages. The client had no periodic tail read when it missed the working signal.

**Enforcement:** `session-sync-controller.test.ts` requires a watched idle session to fetch its tail after 30 seconds. `handle-event.test.ts` requires terminal status events to reconcile without a prior busy frame.
