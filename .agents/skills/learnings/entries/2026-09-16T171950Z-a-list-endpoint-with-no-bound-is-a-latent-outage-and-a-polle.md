---
recorded: 2026-09-16T17:19:50Z
incident_date: 2026-09-16
commit: 6f52904b61
---
# A list endpoint with no bound is a latent outage, and a POLLED one is a scheduled one

**When:** adding or reviewing any endpoint that returns "all the X for this Y",
and any client that polls one. `GET /v1/projects/:projectId/sessions` returned
every session row the viewer could see. It was correct at 60 rows and fine for a
year. At 12,617 sessions it was ~11.1 MB of JSON, re-fetched **every 5 seconds**
— because the sidebar's poll gate (`shouldPollProjectSessions`) asks whether ANY
row is still `queued`/`branching`/`provisioning`, and over twelve thousand rows
one always is. Unbounded list × unbounded poll predicate = the product becomes
unusable with no code change and no alert. **Rules.** (1) A collection endpoint
ships with a default `limit` and a hard ceiling from the first commit; "callers
only have a few" is an assumption about data you have not verified, and the
learning register exists because those assumptions expire. (2) Page by KEYSET on
a unique tuple, never `OFFSET` — rows are written constantly, so an offset page
skips and repeats between requests. (3) A poll interval derived from "does any
row have state X" must be derived from a BOUNDED set, or it never backs off.
(4) Bounding a list changes what every `.find()` on it can still see: seven
surfaces here resolved the CURRENT session by scanning that list, and a session
older than page one silently answered `null` — which read as "you may not share
or stop this". When you bound a list, grep every consumer for `.find(` and move
id lookups to the read-by-id route. *Incident:* prod, customer project, reported
as "ITS GIGA LAGGING"; no alert fired — every request was a 200.
*Enforcer:* `SESSION_PAGE_MAX_LIMIT` (route rejects `limit > 200` with 400) and
the cursor/paging tests in `apps/api/src/projects/lib/session-inventory.test.ts`.
