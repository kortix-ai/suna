---
recorded: 2026-08-22T20:10:22Z
incident_date: 2026-08-22
commit: de32ebf0dd
---
# Fence every detached lifecycle mutation with a durable operation id

**When:** an HTTP handler returns before a sandbox stop, start, or recovery
finishes. Acquire one database claim per `session_id`. Predicate every provider
step and completion write on that claim. A client mutation flag cannot serialize
tabs, refreshes, or repeated requests. *Incident:* session
`ebdcac7f-58bd-4a9f-ad82-b5f536f12c9c` accepted three restarts in 27 seconds and
oscillated through `running -> provisioning -> stopped -> running -> stopped`.
*Enforcer:* `runtime-restart-fence.test.ts` and the restart compare-and-set query.
