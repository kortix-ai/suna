---
recorded: 2026-09-10T19:01:58Z
incident_date: 2026-09-10
commit: 4dc4365e02
---
# Self-host memory adjustments must survive CLI regeneration

**Incident.** Before the SampleCo update, both frontend replicas had restarted
234 times. Logs repeatedly reported `Reached heap limit`. Each container
had a 512 MiB limit while the 16 GiB host had about 9.9 GiB available.
The CLI hardcoded the frontend limit, so editing generated Compose would
be overwritten by the next manual update.

**Rule.** Expose per-service resource adjustments through persisted instance
configuration. Map the configuration key to that service. Verify the actual
CLI command and the resolved Docker Compose configuration before a rollout.

**Enforcement.** `KORTIX_FRONTEND_MEMORY_LIMIT` overrides the frontend limit
with a 512 MiB default. Its service mapping selects only `frontend`.
The CLI regression verifies `env set` and a later `init` preserve the value.
A real CLI/Docker Compose check resolves 536870912 bytes by default and
1073741824 bytes after configuring `1024m`, including after another `init`.
All 134 focused self-host tests pass. Live SampleCo verification follows
the production release and manual update.
