---
recorded: 2026-09-17T00:27:28Z
incident_date: 2026-09-16
commit: 038431ed9d
---
# Bounding a list API strands every OLDER client that shipped before the paging UI

**When:** adding a default `limit` to a collection endpoint an existing frontend
already consumes, and choosing the deploy ORDER. v0.13.20 rolled the API before
the web app. For that window `kortix.com` ran the 0.13.19 frontend — no
`hasNextPage`, no Load more — against the 0.13.20 API, which answers 50 rows.
The list was fast and **truncated with no control to reach the rest**: the old
client cannot ask for page two because it does not know pages exist. Reported as
"its working but there is no load more btn". The rule: a bound is a BREAKING
change for any client that assumed "all", even though the response shape is
byte-compatible. Ship the client that can page FIRST (it works against an
unbounded API — it just never gets a cursor), then bound the server. Where the
order cannot be controlled, keep the old default unbounded behind an explicit
opt-in (`?limit=`) until the client rollout completes. *Incident:* prod
v0.13.20, ~11 min of API-ahead-of-frontend skew, self-resolving.
*Automation:* none — candidate: deploy-prod orders web before api when the
release touches a list contract.
