---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Run browser SQL against the deployed target's test database

**When:** a Playwright journey seeds or reads the database. Prefer `KE2E_DATABASE_URL` and `E2E_DATABASE_URL` over `DATABASE_URL` from local dotenv files. *Near-miss:* the v0.13.15 preview admin grant used a different database; the UI's role probe returned `200` without admin access. *Enforcer:* `tests/e2e/helpers/database.ts` selects the target database, and the admin journey reads `/v1/user-roles` after its grant.
