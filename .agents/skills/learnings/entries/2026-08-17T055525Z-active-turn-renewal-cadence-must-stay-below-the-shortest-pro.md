---
recorded: 2026-08-17T05:55:25Z
incident_date: 2026-08-17
commit: 94eb48073c
---
# Active-turn renewal cadence must stay below the shortest provider backstop

**When:** changing sandbox maintenance cadence, provider lifecycle timers, or active-turn renewal. Run exact-turn renewal in a separate leader-owned loop capped at 30 seconds. Do not couple it to the five-minute project-maintenance sweep. Scope the fast lane to durable `activeTurn` or `activeTurns` authority only.
*Incident:* Dev Daytona renewed once, then stopped an exact active OpenCode turn 68 seconds later because the next project-maintenance pass was scheduled five minutes later than the one-minute deterministic provider timeout.
*Enforcer:* `active-turn-renewal.test.ts` caps the loop at 30 seconds and requires `activeTurnsOnly`; `sandbox-reaper.test.ts` excludes idle rows from the fast lane; the live provider harness uses a one-minute native timer.
