---
recorded: 2026-10-09T19:50:33Z
incident_date: 2026-10-09
---
# Run project boot hooks on every provider resume, and verify the resumed service rather than the mountpoint

**Rule:** Run `sandbox.on_boot` after an in-place provider resume. Treat an
existing mountpoint or status file as stale until a live read succeeds.

**Trigger surface:** Session stop, archive, resume, sandbox migration, and any
project boot hook that owns a network mount or long-lived connection.

**Incident:** 2026-10-09, production. A migrated session passed its initial
mount verification and was archived. Its resumed Platinum VM retained dead
SSHFS mountpoints, so file access returned `EIO` while the status file still
reported every share mounted. The live reproduction also found that the daemon
ran as `kortix` but opened its hook log under `/var/log`. The failed log open
prevented the hook process from starting.

**Enforcement:** `apps/api/src/projects/lib/__tests__/sandbox-runtime-refresh.test.ts`
requires the resume refresh to request `on_boot=1` and retry a concurrent
refresh. `apps/kortix-sandbox-agent-server/src/__tests__/refresh-route-guards.test.ts`
requires direct service authentication before the daemon launches the hook.
`apps/kortix-sandbox-agent-server/src/__tests__/on-boot.test.ts` requires the
hook to run even when its log file cannot be opened.
