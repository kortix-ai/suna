---
recorded: 2026-09-26T15:56:50Z
incident_date: 2026-09-05
---
# A liveness TTL that only one caller refreshes kills the thing it protects

**Rule:** a TTL that expresses "is this run alive?" must be refreshed by the
thing that MAKES it alive, not by an optional courtesy call. `chat_turn_streams.expires_at`
was a reaper inside `loadTurn`: the row was deleted the moment the 15-minute
TTL passed, and exactly one caller refreshed it — `relayTurnStep`, i.e. the
agent choosing to narrate a step. Model tokens, tool calls, edits, and long
build steps never touched it. A run that went quiet longer than the TTL
destroyed its own stream, so every later step and the final answer found no
row and were silently dropped — while the route still answered the sandbox
`200 {"ok":false}`, so the agent believed it had replied. Never return
"not delivered" inside a `200` and call it handled: give the caller a way to
learn its answer was discarded, and fall back to durable session metadata
(channel + thread) to deliver it anyway.

**Trigger surface:** any liveness/TTL mechanism gating whether a background
run's output gets delivered — chat relays, long-running turn state, anything
where "silence" is used as a proxy for "dead."

**Incident:** four days of Kortix appearing to "ignore" Slack incident
mentions. The agent ran correctly every time (session-bound, on-topic, right
project); its output was thrown away by the TTL reaper. Session `e58ddd55`:
a 24m40s gap between narrated steps reaped the row at 13:09:42; five more
steps and the final answer went nowhere while the agent worked two more hours.
The identical defect existed in the Teams channel's copy of the same code.

**Enforcement:** `apps/api/src/__tests__/unit-slack-turn.test.ts` and
`unit-teams-turn.test.ts` pin that a turn row past `expires_at` is still live,
and that a rescue delivery lands (with a duplicate-post guard) when the row is
already gone. Referenced by the 2026-09-25 entry "A sweep that reads silence
as death kills healthy runs," which repeats this same TTL-refresh shape in the
stale-turn sweep.
