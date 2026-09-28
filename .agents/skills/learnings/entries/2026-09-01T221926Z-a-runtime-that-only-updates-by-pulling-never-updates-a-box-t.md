---
recorded: 2026-09-01T22:19:26Z
incident_date: 2026-09-01
commit: ff687f9656
---
# A runtime that only updates by pulling never updates a box that predates the puller

**When:** designing or relying on any "the box converges on the API" mechanism
(runtime-assets, daemon self-update). A daemon built before the pull code
exists never pulls; restart/resume keep the VM and warm-fork keeps the disk, so
every box from before the cutover is a fossil until the CONTROL PLANE reaches
into it through the provider's own exec channel. Ship the push path with the
pull path, and probe the fleet for boxes whose `/kortix/health` has no `runtime`
block. *Incident:* OpenCode's 48-bit message-id rollover (2026-08-14) silently
broke every pre-wrap session on OpenCode < 1.18.15; the fix (1.18.15) never
reached July boxes — 9 prod sessions dead 19 days, 4 h 15 m zombie turns.
*Automation:* `legacy-runtime-bootstrap.ts` scheduled from `box-reaper` (PR #7088);
`scripts/legacy-runtime-sweep.ts --dry-run` lists what is still legacy.
