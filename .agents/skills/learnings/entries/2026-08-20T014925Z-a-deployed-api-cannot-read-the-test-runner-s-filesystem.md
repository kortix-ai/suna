---
recorded: 2026-08-20T01:49:25Z
incident_date: 2026-08-20
commit: 1a2daf491b
---
# A deployed API cannot read the test runner's filesystem

**When:** writing any e2e fixture that hands the API a path — `repo_url`, a file
URI, a callback host. It works locally because the API is the same machine, and
fails only against a deployed target, where the origin 5xx arrives laundered as
`503 MAINTENANCE_MODE` and looks like an outage. Branch the fixture on the
target (`src/fixtures/world.ts` and `tests/e2e/helpers/manifest-project.ts` are
the pattern: local bare repo on `local`, provisioned managed-git otherwise).

*Incident:* specs 21/22 pointed staging at `/tmp/ke2e-git-*/remote.git` on the
GitHub runner; trigger writes 502'd and the resource-grants agent list came back
silently EMPTY. PR #6632.
