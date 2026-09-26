---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-02
commit: 3caec60726
---
# A compatibility repair must recognize the current writer's exact output

**When:** adding a repair that runs before later prompt delivery. Derive both the
current and legacy transcript forms without file I/O. Treat an exact current form
as already repaired. Materialize only parts that still use the legacy file shape.
*Incident:* a new multi-file first prompt used `<commandId>` paths; the next prompt
expected `legacy-<commandId>` and stayed queued. Early fixes exposed crash-window
and overwrite defects. *Enforcer:* `legacy-inline-attachment-repair.test.ts` and
`queued-continue-inbox-delivery.test.ts` cover canonical, legacy, retry, and mixed batches.
