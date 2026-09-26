---
recorded: 2026-08-24T06:43:49Z
incident_date: 2026-08-24
commit: 1583bda9c9
---
# Browser idle is not network idle

**When:** deferring a large non-critical request. Do not use
`requestIdleCallback` as a first-paint network gate; network waits create idle
main-thread windows immediately. Fetch at the user-demand boundary instead.
*Incident:* an idle callback started the 4.07 MB LLM catalog during every
session open. *Enforcer:* `llm-catalog-demand-loading.test.ts` bans layout boot.
