---
recorded: 2026-09-15T06:42:47Z
incident_date: 2026-09-15
commit: aada3f2a08
---
# Match an actual PEM block before calling a 404 page a private-key leak

**When:** checking web error pages for secret content. A bare `BEGIN PRIVATE KEY` phrase can occur in bundled parser code on a 404 page. Require PEM delimiters and encoded key material. *Near-miss:* the v0.13.15 preview gate marked `/.env` exposed although it returned 404; the 1.4 MB frontend error page contained only the phrase. *Enforcer:* `SEC-J` in `tests/src/flows/security-backlog.flow.ts` matches a complete key block.
