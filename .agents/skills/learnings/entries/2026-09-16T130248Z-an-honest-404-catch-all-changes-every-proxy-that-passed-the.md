---
recorded: 2026-09-16T13:02:48Z
incident_date: 2026-09-15
commit: 8a7945bb61
---
# An honest 404 catch-all changes every proxy that passed the old status through

**When:** replacing a permissive fallback (SPA HTML 200) with a strict 404. Grep
every API route that calls a daemon path the daemon does not serve, and give
each one an explicit answer. `/v1/p/share` then leaked the daemon's 404 as
"sandbox not found". Never pick 502 for a permanent refusal: the `index.ts`
edge middleware sends every 502 as a retryable 503. *Near-miss:* RUN-8 failed
twice on the #7148 preview (404, then 503). *Enforcer:* `share-upstream.test.ts`
pins the daemon marker and the 501 mapping.
