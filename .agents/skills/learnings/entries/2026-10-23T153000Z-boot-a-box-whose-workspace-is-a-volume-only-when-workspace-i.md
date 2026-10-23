---
recorded: 2026-10-23T15:30:00Z
incident_date: 2026-10-23
---
# Boot a box whose /workspace is a volume only when /workspace is a mountpoint; never fill the box disk in its place

**Rule:** A box started with `KORTIX_WORKSPACE_VOLUME=1` checks `mountpoint -q /workspace` before the daemon starts, waits up to 60 s for a late mount, and then fails the boot. It never starts kortixd on an unmounted `/workspace`: kortixd would see an empty directory, fill it from Git, and the session would go on without its files while the volume still holds them.

**Trigger surface:** `apps/sandbox/entrypoint.sh`, the workspace-volume create path (`platform/services/workspace-volume.ts`), any new Platinum template or Platinum release that touches volume mounts, and any other feature that keeps state on a mounted volume.

**Incident:** 2026-10-23, found while verifying stateless workspace-volume sessions (PR #TBD), on the Kortix dev org (Platinum production). Every Platinum template built on 2026-10-23 starts a stopped box with a private volume mount in 44.6–47.4 s (n=12) instead of 0.8–3.3 s (n=9); on a plain `ubuntu:24.04` template the volume was not mounted after that start (3 of 3 runs, `/workspace` empty). No session was affected: the flag is off everywhere. Raw data: the PR body.

**Enforcement:** the entrypoint check in `apps/sandbox/entrypoint.sh` (`mountpoint -q "${WORKSPACE}"`). None yet that goes red: the enforcer to build is an entrypoint test that runs the script with `KORTIX_WORKSPACE_VOLUME=1` on a plain directory and asserts exit 1.
