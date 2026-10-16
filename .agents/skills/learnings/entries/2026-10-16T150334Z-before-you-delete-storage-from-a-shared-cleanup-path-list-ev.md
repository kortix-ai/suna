---
recorded: 2026-10-16T15:03:34Z
incident_date: 2026-10-16
---
# Before you delete storage from a shared cleanup path, list every caller of that path and gate the delete on the state that means the data is unwanted

**Rule:** A function that deletes durable storage (a volume, a bucket prefix, a repo) checks, itself, the state that makes the data unwanted (the session's `deletedAt`). Never rely on its callers being delete paths: grep every caller of the lane you hook it into first.

**Trigger surface:** Adding a storage delete to a reaper or removal lane such as `attemptArchivedBoxRemoval` (`projects/reaping/archived-box-removal.ts`), which session delete, restore, lost-session recovery and stuck-provisioning cleanup all call.

**Incident:** 2026-10-16, the `workspace_volume` PR, local stack only (near miss, never merged). The first cut deleted a session's `/workspace` volume after every confirmed box removal. A real lost-session recovery (`POST …/recover`) runs the same lane, so the fresh box would have mounted a new empty volume: the only copy of the session's files gone. Found by running the recovery on a real Platinum box before the merge.

**Enforcement:** `apps/api/src/__tests__/integration-workspace-volume.test.ts`: "a session that is not deleted keeps its volume when its box is removed" fails if `deleteWorkspaceVolume` stops checking `deletedAt`.
