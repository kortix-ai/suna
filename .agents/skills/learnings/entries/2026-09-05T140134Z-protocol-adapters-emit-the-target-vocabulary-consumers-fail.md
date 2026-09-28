---
recorded: 2026-09-05T14:01:34Z
incident_date: 2026-09-04
commit: 1bac1e4dd7
---
# Protocol adapters emit the target vocabulary; consumers fail active-safe

**When:** adapting runtime lifecycle events into the OpenCode session protocol.
Emit only `idle`, `busy`, or `retry`. Treat only explicit `idle` as idle when
reading an untrusted status discriminator. *Incident:* the pi worker emitted
`running`; the SDK converted it to `idle`, so the composer and sidebar hid their
busy indicators while parts continued to stream. *Enforcer:*
`session-status.test.ts` and `use-session-working.test.ts`.
