---
recorded: 2026-09-10T21:31:38Z
incident_date: 2026-09-10
commit: b068d62921
---
# An alarm for a STANDING condition must be edge-triggered

**When:** logging at error level from anything that runs on a schedule. If the
condition it reports is standing rather than transient, every pass re-logs it
and the alarm becomes wallpaper. Speak on arrival, at most hourly while it
persists, and once when it clears — never delete the signal.
*Incident:* `[snapshot-gc] BUDGET UNRESOLVED` fired 1,936 times in seven days,
~11/hour, with `org` drifting 264→319 against `limit=100` and nothing changing
between any two messages. Deleting it was not an option — the first outage in
that area happened because a GC that could not cope logged nothing.
*Enforcer:* `budget-report-policy.test.ts`.
