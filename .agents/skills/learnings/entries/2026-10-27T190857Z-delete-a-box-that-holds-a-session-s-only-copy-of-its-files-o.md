---
recorded: 2026-10-27T19:08:57Z
incident_date: 2026-10-27
---
# Delete a box that holds a session's only copy of its files only after the storage reports those files saved

**Rule:** Before any code path deletes a box whose disk or mount may hold the session's only copy of a file, ask the storage whether everything the box wrote is saved. Keep the box when the answer is anything but a clear yes. For a `workspace_volume` session that answer is Platinum's `GET /v1/volumes/:v/health?probe=false` with `status: ok`. "The stop commits the volume" is not that answer: the commit can fail.

**Trigger surface:** Code that removes a Platinum box of a `workspace_volume` session: the idle lane (`apps/api/src/projects/reaping/idle-volume-retire.ts`), lost-box recovery, archived-box removal, or any new reaper. A change to how a stop saves `/workspace`.

**Incident:** 2026-10-27, a near-miss found while reviewing a Platinum production incident. A Platinum box's mount was too large to index (4.2M files). Every commit failed for about 4 h, and at the auto-stop Platinum discarded 14.6 GB of writes that were never saved (fixed in Platinum #2028, which now keeps such a mount and reports it `unflushed`). The Kortix idle lane deleted every `workspace_volume` box stopped longer than 60 min without asking whether its volume was saved, on the claim that the stop always commits. A session whose stop could not save would have lost those files for good when the lane deleted its box. Kortix impact: none known: `workspace_volume` was on for one dev project only. On 2026-10-27 Platinum #2028 was not yet on the us-east host, where the dev volumes live.

**Enforcement:** `apps/api/src/__tests__/integration-workspace-volume.test.ts` ("the idle lane keeps a box whose volume is not ok") goes red when the lane deletes a box whose volume health is `degraded` or `stuck`, whose volume answers `404 volume_not_found`, or whose session has no valid volume record.
