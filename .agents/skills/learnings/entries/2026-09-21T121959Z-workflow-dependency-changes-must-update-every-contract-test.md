---
recorded: 2026-09-21T12:19:59Z
incident_date: 2026-09-21
commit: 76324bab3e
---
# Workflow dependency changes must update every contract test

**Rule:** Search the repository for every changed workflow dependency list and
update all matching contract tests in the same commit. Run the full package lane,
because workflow contracts can live under an application test suite instead of
`tests/unit`. **Incident:** PR #7448 intentionally removed npm publish jobs from
`github-release.needs` and added a stronger graph test, but left the older web
test expecting those jobs. The core lane passed while the package lane failed on
every PR. **Enforcer:** `apps/web/scripts/validate-production-supabase-env.test.mjs`
pins the current release prerequisites. The package lane executes that test.
