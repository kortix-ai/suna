---
recorded: 2026-09-29T00:07:41Z
incident_date: 2026-09-28
---
# A failed inbox interrupt arm belongs on the unreachable ladder, never on the 2 s order backoff

**Rule:** When `armQuickQueueInterrupt` reports the runtime did not serve the boundary interrupt, park the row through `parkPromptForUnreachableRuntime` (the delivery path's ladder: 30 s → 2 m → 8 m, 3 tries, then an honest failed row). Never requeue a failed arm on the admission order backoff — that clock is capped at 2 s on purpose and assumes the turn WILL end.

**Trigger surface:** `apps/api/src/services/sessions/lifecycle/queued-continue.ts` (`admitQueuedContinue`), `runtime-client.ts` (`armQuickQueueInterrupt`), `quick-queue-control.ts` — anywhere an inbox row waits behind `turn_active`.

**Incident:** 2026-09-28, prod API. The `[session-lifecycle] Quick Queue boundary interrupt unavailable` warn pattern went from a 0.08/h baseline to ~1,900 warns in 85 minutes: one prod session whose box stopped answering while its sandbox metadata still held an active turn. Admission refused with `turn_active` every ~2.5 s, re-armed the interrupt every cycle, every arm failed, and the loop had no exit — the terminal relay never fires for a dead runtime, refusals do not burn the attempt budget by design, and the reaper leaves a provider-running box alone. Four separate sessions looped the same way that day (2, 48, 8, and 1,900+ warns).

**Enforcement:** `apps/api/src/services/sessions/lifecycle/__tests__/queued-continue-inbox-delivery.test.ts` — "a runtime that will not serve the interrupt parks the row on the unreachable ladder, not the 2 s order backoff" and "after the unreachable budget the interrupted row fails honestly instead of waiting for ever"; both fail without the fix.
