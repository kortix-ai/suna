---
recorded: 2026-10-29T15:53:16Z
incident_date: 2026-10-29
---
# Test a workspace-volume change on a project that boots from the S3 project snapshot, not only on one that clones with git

**Rule:** Before you turn `workspace_volume` on for a project, or change how kortixd fills or clears `/workspace`, run one real session on a project that boots from the S3 project snapshot (`/kortix/health` → `workspace_provider.s3_attempted: true`) as well as on one that clones with git. Never delete `lost+found` at the volume root: it belongs to root, and the runtime user can neither list nor remove it when the entrypoint could not.

**Trigger surface:** turning `workspace_volume` on for a project; `apps/kortix-sandbox-agent-server/src/services/workspace-provider/` (`clearDirContents`, `swapStageIntoTarget`, the S3 and git transports); `apps/sandbox/entrypoint.sh`.

**Incident:** 2026-10-29, v0.14.9 in production. `workspace_volume` was on for the company project for 2 minutes; the one session created in that window never became ready (`EACCES: permission denied, rm '/workspace/lost+found'`, S3 stage `activate`, reason `malformed`). The entrypoint's `sudo -n rmdir` had left `lost+found` in place, and the snapshot swap cleared every root entry. The prod test before it passed 5 of 5 on a project that clones with git. Fix: PR (this branch).

**Enforcement:** `src/__tests__/workspace-provider.test.ts` "an empty workspace volume is filled from S3 and health reports the volume" fills a volume whose `lost+found` is unlistable and asserts the S3 boot succeeds, keeps `lost+found`, and hides it from git.
