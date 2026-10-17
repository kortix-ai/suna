---
recorded: 2026-10-16T18:33:14Z
incident_date: 2026-10-16
supersedes: 2026-10-16T150334Z-before-you-delete-storage-from-a-shared-cleanup-path-list-ev.md
---
# Before you delete storage from a shared cleanup path, list every caller of that path and gate the delete on the state that means the data is unwanted (enforcer retired with the workspace volume revert)

**Rule:** Unchanged from the superseded entry: a function that deletes durable storage checks, itself, the state that makes the data unwanted, and every caller of the lane it hooks into is listed first.

**Trigger surface:** Adding a storage delete to a reaper or removal lane such as `attemptArchivedBoxRemoval` (`projects/reaping/archived-box-removal.ts`); the next design that persists `/workspace` (for example in S3) is the expected one.

**Incident:** 2026-10-16. The `workspace_volume` feature (PR #10047) was reverted the same day: Platinum volumes were judged not stable enough to hold the workspace. The near miss of the superseded entry stays true; only its code is gone.

**Enforcement:** none yet: `integration-workspace-volume.test.ts` left with the revert. The next storage-delete hook in the removal lane needs its own "a session that is not deleted keeps its storage" test.
