---
recorded: 2026-10-23T15:38:53Z
incident_date: 2026-10-23
---
# Retry a transient pi model step inside pi's loop, never after session.prompt returns

**Rule:** A retried model step must re-enter pi's own run loop. Retry it from the `agent_before_settle` boundary (`turnExtension` in `pi/runtime.ts`) and omit the failed attempt with a `context_edit` draft. Never retry by calling `agent.continue()` after `session.prompt` returns.

**Trigger surface:** Any change to `TransientRetry`, to the pi runtime's `runTurn`/`turnExtension`, or to the recovery gate (`recovers`, `recoveryTried`).

**Incident:** 2026-10-23, same session as the compaction-threshold incident. A step that Kortix's transient retry continued ran outside pi's `AgentSession` loop, so `_handlePostAgentRun` never ran for it: no threshold compaction, and an overflow or a cut answer was final. The runtime compensated in `recovers()` by withholding the error when `turnRetry.retried`, which could only ever show "Compacting the conversation to continue." — pi never compacted. A provider blip during a long turn therefore disabled compaction for the rest of that turn.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` `an overflow after a transient retry still compacts and retries: the retry stays inside pi loop` drives a cut stream, then an overflow, through the daemon HTTP routes and requires the compaction part plus a completed answer with no `session.error`; the retry-status, abort-during-backoff, outage-resume and budget-exhausted tests pin the rest of the schedule.
