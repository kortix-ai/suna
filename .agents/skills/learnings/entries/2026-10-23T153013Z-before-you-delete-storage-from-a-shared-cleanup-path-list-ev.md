---
recorded: 2026-10-23T15:30:13Z
incident_date: 2026-10-16
supersedes: 2026-10-16T183314Z-before-you-delete-storage-from-a-shared-cleanup-path-list-ev.md
---
# Before you delete storage from a shared cleanup path, list every caller of that path and gate the delete on the state that means the data is unwanted (enforcer restored with stateless workspace volumes)

**Rule:** Unchanged: a function that deletes durable storage checks, itself, the state that makes the data unwanted, and every caller of the lane it hooks into is listed first.

**Trigger surface:** A storage delete in a reaper, removal or retention lane. The `/workspace` volume of a session (`platform/services/workspace-volume.ts`) is deleted only by the retention purge after the trash window (`projects/session-log-purge.ts`, objects phase) and by account erasure; the box-removal and idle-retire lanes remove boxes only.

**Incident:** 2026-10-16 near miss of the superseded entry. 2026-10-23: stateless workspace volumes (PR #10846) bring the feature back with the delete moved out of the box-removal lane, so a deleted session keeps its volume while it can be restored.

**Enforcement:** `apps/api/src/__tests__/integration-workspace-volume.test.ts`: "a deleted session keeps its volume through the trash window; the purge deletes it at its region" and "the idle lane retires and removes only a volume session box stopped past the window" (no volume call).
