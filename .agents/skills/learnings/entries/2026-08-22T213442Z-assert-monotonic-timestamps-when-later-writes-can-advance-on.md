---
recorded: 2026-08-22T21:34:42Z
incident_date: 2026-08-22
commit: bc8259eff9
---
# Assert monotonic timestamps when later writes can advance one field

**When:** a test reads two timestamps written by one statement after asynchronous
lifecycle work starts. Require the invariant's monotonic order. Do not require
equality when later writes can advance one field before read-back. *Near-miss:*
release gate run 32598056475 failed `SESS-18` after `updated_at` advanced 223 ms
past `last_activity_at`. *Enforcer:* `SESS-18` requires
`last_activity_at > created_at` and `updated_at >= last_activity_at`.
