---
recorded: 2026-09-16T19:33:54Z
incident_date: 2026-09-16
commit: 5b6a5a0aec
---
# A gate the product cannot clear is a dead end

**Rule:** every refusal must carry its remedy — a link, a button, a next
command — and a refusal that can only be cleared from a surface that does not
exist must not exist. **When:** adding a pre-flight check (create-time,
admission-time) ahead of a real action. Before shipping it, name the exact UI
control or CLI command that clears it, for every caller who can hit it
(including a service account). If none exists, the gate is the bug, not the
missing UI. *Incident:* a `user`-strategy connector had no connect flow
anywhere — no shared account to offer, so the card rendered a button-less
refusal and the composer spun on "Thinking" forever. *Enforcer:*
`apps/api/src/projects/routes/session-prompts.test.ts` ("queues the
prompt even when the project has an unconnected connector"); the denial's
`connect_url` remedy: `apps/api/src/connectors/principal-access.ts:110-114`.
