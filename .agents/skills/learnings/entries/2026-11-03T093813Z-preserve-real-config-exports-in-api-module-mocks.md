---
recorded: 2026-11-03T09:38:13Z
incident_date: 2026-11-03
---
# Preserve real config exports in API module mocks

**Rule:** Spread real config exports before test-specific overrides. Load config with the hermetic test environment, not encrypted local secrets.

**Trigger surface:** API tests that replace the config module with `mock.module`.

**Incident:** Release v0.14.17, PR #11536, failed four API imports because config stubs omitted `childProcessEnv`.

**Enforcement:** The teams authorization, gateway usage deadline, session drain error and public setup-link tests fail at import without the export. Run with Bun 1.4.3 and the suite's isolate, parallel and environment flags.
