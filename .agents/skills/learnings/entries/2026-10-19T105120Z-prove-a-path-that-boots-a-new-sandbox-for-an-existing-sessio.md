---
recorded: 2026-10-19T10:51:20Z
incident_date: 2026-10-19
---
# Prove a path that boots a new sandbox for an existing session by asking the agent about an earlier turn

**Rule:** A path that replaces an existing session's sandbox (restore after delete, recover a lost session, any retired-row reclaim) must turn the session-log restore at boot on for that session (`resolveSessionHarness` in `session-sandbox-env-build.ts`). Prove it on a real box: after the new box boots, ask the agent to quote an earlier message. A transcript that still reads back from the saved copy proves nothing about the agent's context.

**Trigger surface:** Writing or reviewing code that sets `externalId: null` / `ephemeralRetiredExternalId` on a sandbox row, or any lifecycle route that makes the next open provision a fresh box for an old session.

**Incident:** 2026-10-19, found while testing Recently deleted (KRTX-2853). Restore after delete (#9792, KRTX-1734, in prod since v0.14.2) retired the sandbox row, so the next prompt booted a fresh box, but only `lostRecoveredAt` or the `session_log_restore` project flag turned the boot restore on. The fresh box started an empty native conversation, the session's runtime identity moved to it, and the page showed no history (a restored session: `message_count: 0`). Every Undo and every restore of a session whose box was removed hit it. SESS-51 passed throughout: it asserted the retired row and the saved transcript read-back, never the new box's env. Fixed in #10260: restore stamps `restoredAt` and converts the v1 mirror to the session log.

**Enforcement:** `integration-session-env-grants.test.ts` asserts KORTIX_SESSION_LOG_RESTORE=1 for both `lostRecoveredAt` and `restoredAt`; SESS-51 asserts a restore leaves `restoredAt` and a session log. Not enforced: a new lifecycle path that retires a row without a marker. The enforcer to build: a DB-suite check that every `transitionSandbox` call writing `RETIRED_EXTERNAL_ID_KEY` is paired with a boot-restore marker on the session.
