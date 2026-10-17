---
recorded: 2026-10-16T17:09:03Z
incident_date: 2026-10-16
---
# Never write the row on a terminal /start answer: the write becomes a frame that re-reads /start

**Rule:** A `/start` answer that is terminal (`retriable: false`) must come from the row with no provider call and no row write. Any write on that path changes the box row, the session stream turns the change into a runtime frame, and the SDK re-reads `/start` on a changed frame (`use-session-stream.ts`), so the client and server feed each other at the `/start` latency.

**Trigger surface:** Editing `runOpenSession` (`apps/api/src/projects/session-open/`), the removed-box recovery path, `preserveEstablishedRuntime`, or any `/start` branch that claims, stamps or transitions a row before it answers.

**Incident:** 2026-10-16, local stack. A new session adopted a pre-warmed session whose box Platinum had removed. With the page open, `dev` code sent 365 `POST /start` in 60 s, logged `runtime.lost` (with a Sentry event) 182 times, and made 182 Platinum restore calls: each `/start` claimed a recovery (row `provisioning`) and preserved the loss again (row `stopped`). The "report once" check read the post-claim state and never matched. Fixed in the PR that adds `LOST_RUNTIME_RECHECK_MS` (5 min): 2 `/start`, 1 log, 1 restore call in the same 60 s.

**Enforcement:** `apps/api/src/__tests__/unit-session-runtime-guards.test.ts` "the next start on a lost session answers from the row: no provider call, no write" (a second `/start` must not read the provider or change the row); `stopped-wake-result.test.ts` pins the window; `runtime-identity-park-ledger.test.ts` pins the report-once rule after a recovery claim.
