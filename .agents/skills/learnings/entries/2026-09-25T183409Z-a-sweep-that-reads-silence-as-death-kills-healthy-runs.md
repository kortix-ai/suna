---
recorded: 2026-09-25T18:34:09Z
incident_date: 2026-09-25
commit: d6d3de1653
---
# A sweep that reads silence as death kills healthy runs

**Incident.** A prod Slack run posted one `slack step`, then worked for 30
minutes without another. Two `task` subagents made model calls every minute,
with 0 gateway failures. At 30m56s the Slack stale-turn sweep closed the
thread as "Run timed out — it may have stalled or run out of credits" and
aborted the runtime turn (`MessageAbortedError`), killing both subagents.
Estimate over the previous 30 days: 40 of 71 Slack turns longer than 30
minutes had a relay gap over 30 minutes before their answer. Each had its
thread closed. From 2026-09-21 (`e43253cb2f`) the sweep also aborted the run.
The Teams sweep had the same defect. It got a liveness check on 2026-09-23;
the Slack sweep did not.

**Cause.** The sweep's only liveness signal was `chat_turn_streams.updated_at`.
Only channel relays (`slack step`, `slack send`) write that column. The run's
own work writes nothing there. The same shape as the 2026-09-05 `expires_at`
reaper: a liveness TTL that only one caller refreshes.

**Rule.** A reaper that closes or aborts a run asks the lifecycle authority
(`sessionHoldsLiveTurn` → `session_sandboxes.metadata.activeTurns`) first. The
silence of a UI surface is never proof of death. A fix to one channel's sweep
is ported to every channel's sweep in the same change.

**Enforcement.** `apps/api/src/__tests__/unit-slack-turn-sweep.test.ts` and
`unit-teams-turn.test.ts`: a stale turn the runtime still holds is touched,
not closed, and not aborted. An unreadable authority counts as not live.
