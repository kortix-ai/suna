---
recorded: 2026-08-24T16:04:08Z
incident_date: 2026-08-24
commit: 4f4a05a7a3
---
# A snapshot build stuck in progress silently rolls every later resume back

**When:** operating pause/resume sandbox lifecycles where each pause appends a
diff build and resume restores the newest build with a ready status. A build
wedged in `snapshotting` is skipped by resume even when its rootfs upload
completed; the sandbox silently boots the pre-wedge state, and every later
pause then snapshots that stale branch as a new "success" build, burying the
good lineage deeper on each cycle. User data vanishes with zero errors on any
surface — the session opens fast and empty. Repair = finalize the wedged
`env_builds` row (`status='success'`, `finished_at=created_at`), mark the
stale-branch builds `failed`, resume. Verify the rootfs object exists in the
`fc-templates` bucket before finalizing. *Incident:* sampleco session
`70f64114` resumed with an empty transcript on 2026-08-24; wedged build
`4b583212` (03:34:23Z, during the wake-race window fixed by `b250949eb1`) had
its full 660 MB rootfs in S3 but the status never flipped; 4 stale builds
stacked on top; a cluster-wide sweep found 71 wedged builds and 11
silent-rollback victim sandboxes. The transcript was recovered by the repair
above. *Enforcer:* none yet — a wedged-build watchdog belongs in the
self-hosted E2B ops (kortix-infra `e2b/ops`), and the sandbox daemon should
detect a restore that is older than Kortix's last-known session activity and
say so instead of serving an empty transcript.
