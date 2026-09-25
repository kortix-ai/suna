---
recorded: 2026-08-24T06:43:49Z
incident_date: 2026-08-24
commit: 1583bda9c9
---
# One React Query key needs one poll owner

**When:** mounting the same query through several session-page components. Give
exactly one stable route-level observer a `refetchInterval`; make every other
observer a cache reader with `refetchOnMount: false`. In-flight deduplication
does not merge independent timers or late stale mounts. *Incident:* five audit
observers produced 9 requests during one SampleCo session load.
*Enforcer:* `session-audit-shared.test.ts` pins one owner and cache-reader mounts.
