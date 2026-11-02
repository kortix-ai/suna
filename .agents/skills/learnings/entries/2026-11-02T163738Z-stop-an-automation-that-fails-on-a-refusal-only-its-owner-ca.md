---
recorded: 2026-11-02T16:37:38Z
incident_date: 2026-11-02
---
# Stop an automation that fails on a refusal only its owner can fix: no retries, pause after a bounded streak, and tell the owner whatever the notification flags say

**Rule:** A trigger fire refused for the account's model, plan, or manifest is terminal on the first attempt. Every run failing that way for 24 hours (at least 3 in a row) pauses the trigger, and the pause notice ignores `notification_center`. A new refusal code joins the terminal list in `trigger-scheduler.ts` and `OWNER_FIXABLE_SOURCES` in `trigger-failure-pause.ts`. A trigger prompt into an existing session passes the billing gate, like a create. Credits and platform faults never pause.

**Trigger surface:** Adding a refusal code to `createSession` or the gateway, a fire path, a retry or dead-letter classification, or an alert behind a feature flag.

**Incident:** 2026-11-02, prod. One free project's 22 cron triggers were pinned to models the account could not use. About 1,250 slots a day were refused since 2026-10-01, each tried 5 times, with no pause and no notice (flag off). A reuse trigger prompted its session on a negative wallet every 30 min (~$4.30/day compute). 23 triggers were paused by hand at 14:01Z. Fix: PR #11477.

**Enforcement:** `apps/api/src/__tests__/integration-trigger-failure-pause.test.ts` (attempt 1 on a model refusal, the 24-hour pause, the flag-off notice, the billing gate on a reuse fire). None yet for a new refusal code that skips the two lists: build a test that maps every `createSession` 4xx `code` to terminal or retryable.
