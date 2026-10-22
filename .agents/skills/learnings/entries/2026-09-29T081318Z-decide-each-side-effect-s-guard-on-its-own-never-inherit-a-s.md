---
recorded: 2026-09-29T08:13:18Z
incident_date: 2026-08-26
---
# Decide each side effect's guard on its own; never inherit a sibling's

**Rule:** When you add a side effect beside guarded siblings, decide its guard for that effect alone. The turn-end handler skips forwarded-turn reconcile and queue promotion for a coordinator-spawned session (`childSession`, `metadata.spawned_by_session`). Those are root-only decisions. Saving the transcript is not: every session has its own sandbox and OpenCode root, and a spawned session is often never opened.

**Trigger surface:** Adding or moving a side effect in `promoteAfterTurnEnd` (`apps/api/src/projects/routes/turn-stream-handlers.ts`), or any block where neighbours share an `if (!x)` guard.

**Incident:** 2026-08-26 to 2026-09-29. The turn-end mirror capture (#6915) was written inside a copied `if (!childSession)`. No agent-created session saved its transcript at turn end. The transcript read answered `available: false`, and the first person to open one saw a loading bar. A user reported it on dev on 2026-09-29.

**Enforcement:** `apps/api/src/projects/routes/turn-stream.test.ts` ("a coordinator-spawned session skips reconcile and promotion, and still saves its transcript").
