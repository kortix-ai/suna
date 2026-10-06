---
recorded: 2026-09-03T13:39:36Z
incident_date: 2026-09-03
commit: 61934a1acb
---
# Browser fixtures must not require host CLIs that the test image does not install

**When:** adding database setup to a deployed Playwright journey.
**Incident:** three Pi browser journeys stopped at `spawnSync psql ENOENT` before opening the UI.
**Rule:** use the shared `pg` client with parameterized SQL. Do not spawn `psql` from browser fixtures.
**Enforcer:** `test-runner-contract.test.ts` rejects `execFileSync('psql', ...)` in the fixture helpers.
