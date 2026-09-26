---
recorded: 2026-08-27T02:34:54Z
commit: 39685da48d
---
# Self-host update health-gate deadlock: the bug that sickens a replica blocks the update that fixes it

- **Incident (2026-08-27, SampleCo):** the compress 500 bug made the scheduler-leader API replica fail its own docker healthcheck (`/health` JSON >1KB on the leader → gzip path → 500). `kortix self-host update` then aborted every roll with `dependency failed to start: container ... is unhealthy` — compose's health gate refused to replace the sick container with the image that cures it. The box stayed broken through three roll attempts that all reported the same abort.
- **Rule:** when a self-host update aborts on an unhealthy EXISTING container and the update contains the fix for that unhealthiness, `docker rm -f` the unhealthy replicas first, then re-run the update. Read the update's full output — an aborted roll leaves old containers running, so a later health probe answering does NOT mean the roll landed; verify the running commit, not liveness.
- **Enforcement:** none automated yet; candidate = updater flag to replace unhealthy replicas of the service being updated.
