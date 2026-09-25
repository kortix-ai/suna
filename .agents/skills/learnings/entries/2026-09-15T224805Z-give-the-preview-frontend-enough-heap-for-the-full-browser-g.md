---
recorded: 2026-09-15T22:48:05Z
incident_date: 2026-09-15
commit: 036f3b8abe
---
# Give the preview frontend enough heap for the full browser gate

**When:** configuring a full self-host preview. Persist its frontend memory limit
through `KORTIX_FRONTEND_MEMORY_LIMIT`; do not edit generated Compose limits.
*Incident:* PR #7267's frontend restarted five times with `Reached heap limit`
under its 512 MiB container limit while the 16 GiB host had over 12 GiB available.
Browser navigation failures masked the terminal test behind infrastructure noise.
*Enforcer:* `preview-stack.test.ts` requires a 2048 MiB preview frontend limit;
also inspect the deployed container limit and restart count after the full gate.
