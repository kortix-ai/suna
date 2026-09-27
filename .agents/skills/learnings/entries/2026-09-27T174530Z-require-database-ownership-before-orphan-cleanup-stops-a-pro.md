---
recorded: 2026-09-27T17:45:30Z
incident_date: 2026-09-27
---
# Require database ownership before orphan cleanup stops a provider box

**Rule:** Require a versioned database-and-instance ownership marker before orphan cleanup can stop a provider box. A shared credential or environment label is not ownership. Exclude every referenced box, regardless of status, and re-read references before stopping. Change the managed marker itself so older sweepers cannot select protected boxes.

**Trigger surface:** Provider enumeration, sandbox creation, orphan cleanup, and preview fleet cleanup.

**Incident:** On 2026-09-27, authenticated stop requests interrupted a Dev turn. The repeated two-box pattern matched a five-minute cleanup sweep; caller attribution remained unconfirmed. Two databases sharing one provider credential and environment reproduced the unsafe selection. Worker environments were also absent from the keep-set.

**Enforcement:** `integration-sandbox-ownership.test.ts` exercises two real PostgreSQL databases and provider HTTP calls. `platinum-list-managed.test.ts`, `sandbox-reaper.test.ts`, and `preview-session-reaper.test.ts` cover legacy markers, missing instance IDs, reference races, database failures, and bounded cleanup.
