---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Require the durable transcript before stopping a session in a mirror test

**When:** testing stopped-session transcript read-back. A live transcript can contain a streaming marker before the turn-end mirror is captured; wait for `shape=sync` to report a complete mirror first. *Near-miss:* v0.13.15 preview `SESS-24` stopped session A after a live marker but before a mirror existed, then received `available:false` as the route specifies. *Enforcer:* `SESS-24` checks a complete mirror before stop and the same marker afterward.
