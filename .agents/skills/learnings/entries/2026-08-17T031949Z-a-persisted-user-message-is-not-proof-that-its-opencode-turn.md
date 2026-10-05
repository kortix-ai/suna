---
recorded: 2026-08-17T03:19:49Z
incident_date: 2026-08-17
commit: 97fa3aef20
---
# A persisted user message is not proof that its OpenCode turn is active

**When:** changing exact-turn lifecycle probes. Treat a user-only or incomplete assistant message as active only when `/session/status` reports that exact session as `busy` or `retry`. Treat an idle session as terminal. Treat an unreadable or unknown status as unknown and non-renewing.
*Incident:* a native OpenCode prompt persisted its user message but created no assistant message; the exact-message probe returned active for 198 seconds and would have renewed an idle Platinum sandbox indefinitely.
*Enforcer:* `orphaned-turn-finalize.test.ts` covers busy, retry, idle, and unreadable session status.
