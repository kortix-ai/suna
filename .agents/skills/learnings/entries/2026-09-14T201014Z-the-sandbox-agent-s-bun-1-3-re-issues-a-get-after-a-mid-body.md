---
recorded: 2026-09-14T20:10:14Z
incident_date: 2026-09-13
commit: ccd3f7596d
---
# The sandbox agent's Bun 1.3 re-issues a GET after a mid-body reset and appends the second body — never trust length alone

**When:** streaming a download in `kortixd` (compiled with
`SANDBOX_AGENT_BUN_VERSION=1.3.11`). After a socket reset mid-body, Bun 1.3
silently re-issues the request and appends the new response to the SAME
`fetch` body stream (server sees 2 GETs; consumer sees 1st-half + 2nd response,
`close` with no `end`/`error`). Bun 1.4 (laptops) delivers a clean short EOF, so
the suite is green locally and wrong in the image. Rules: (1) compare received
bytes AND sha256 against a trusted descriptor; (2) treat an overrun past the
declared size as transient transport garbage, not "too large"; (3) run the
streaming suite under `oven/bun:<SANDBOX_AGENT_BUN_VERSION>` before shipping.
*Near-miss:* the S3 config provider classified a reset as `malformed` (no
retry) under 1.3.11; caught by running its suite in Docker under 1.3.11.
*Enforcer:* none in CI — `docs/runbooks/project-snapshot-s3.md` carries the
Docker command; a CI lane on the pinned Bun is the TODO.
