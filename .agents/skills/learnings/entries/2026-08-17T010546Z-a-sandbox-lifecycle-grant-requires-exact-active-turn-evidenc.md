---
recorded: 2026-08-17T01:05:46Z
incident_date: 2026-08-17
commit: 344717c09f
---
# A sandbox lifecycle grant requires exact active-turn evidence

**When:** changing session prompt delivery, sandbox reaping, or any sandbox provider lifecycle adapter. Persist token-bound `delivering` authority before upstream delivery. Promote only after OpenCode exposes the exact user `messageID`. Renew both `deadline_at` and the provider-native timer only from a fresh exact-turn probe. Treat unknown evidence as non-renewing. Linearize idle stop against prompt delivery with one database claim, and never let renewal wake a stopped sandbox.
*Incident:* long OpenCode image analyses outlived E2B's absolute timeout and provider idle timers; Kortix displayed “Your session will be restored” while the agent still worked.
*Enforcer:* `sandbox-turn-lifecycle.test.ts`, `integration-sandbox-turn-lifecycle.test.ts`, `sandbox-reaper.test.ts`, `initial-turn-lifecycle.test.ts`, and all three provider lifecycle suites.
