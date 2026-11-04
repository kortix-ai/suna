---
recorded: 2026-10-23T13:26:01Z
incident_date: 2026-10-23
---
# Classify every table that names a session for the retention purge; a copy of the content is content

**Rule:** When you add a table with a `session_id` (or `*_session_id`) column, classify it in `SESSION_TABLES` as purged, scrubbed or kept with a reason. A table that stores a prompt, a model request or response, a message preview or a transcript is content: purge or scrub it in `purgeRows` (`apps/api/src/projects/session-log-purge.ts`).

**Trigger surface:** a migration that adds a session-keyed table; a change to session delete, restore or the retention purge; copy that promises what a delete removes.

**Incident:** 2026-10-23, near-miss found in review. The delete dialog said a deleted session's messages and files are deleted after 30 days. The purge deleted only the session-log and transcript rows at day 30 and the files at day 37. `gateway_request_logs` kept every model request and response, `session_lifecycle_commands` kept prompts, and voice turns, pending questions, notifications and runtime projections stayed forever. The branch was deleted at day 90, while the dialog said "kept". Fixed on branch `session-delete-purge`: everything goes on day 30.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-purge.test.ts` › "every table that names a session is classified for the purge" reads `pg_attribute` on the migrated database and fails on an unclassified table. The same file asserts that each content copy is gone on day 30; `integration-deleted-session-day-30.test.ts` covers the branch on a real Git remote.
