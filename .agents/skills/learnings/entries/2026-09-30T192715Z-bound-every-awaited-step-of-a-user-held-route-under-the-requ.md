---
recorded: 2026-09-30T19:27:15Z
incident_date: 2026-09-30
---
# Bound every awaited step of a user-held route under the request deadline and answer a truthful in-progress state

**Rule:** The sum of every awaited step in a user-held route must fit under the 25 s
request deadline. Race the steps against one budget (under 20 s). Cap each best-effort
step on its own. When the work has not finished, answer 200 with an in-progress state
(`stopping`), keep the work running, and let it commit the final state. Never claim a
state the provider has not confirmed.

**Trigger surface:** Writing or reviewing a route that awaits a provider call plus
other I/O while a user holds a button (`stopSession` in
`apps/api/src/services/sessions/lifecycle/stop.ts`).

**Incident:** 2026-09-30, about 1 per day since 2026-09-27: `POST .../sessions/:id/stop`
answered `503 Request exceeded the 25s server processing deadline` after 25 041 ms.
Steps ran in series: daemon abort (4 s), unbounded transcript tail read (14 s in the
slow case, a 503 from the box), then `provider.stop` (up to 10 s confirm poll) and a
retry after 1 s. The box usually stopped anyway, so the user saw a failure for a
success. PR: fix/stop-within-deadline.

**Enforcement:** `apps/api/src/services/sessions/lifecycle/__tests__/stop.test.ts`
("answers `stopping` inside the budget", "a hung transcript tail does not hold the
stop past its cap").
