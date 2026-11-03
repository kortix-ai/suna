---
recorded: 2026-11-03T09:37:50Z
incident_date: 2026-11-03
---
# Preserve real config exports in synthetic module fixtures

**Rule:** Import actual config before registering a module mock and spread its exports before the existing synthetic overrides. Run with the hermetic test environment.

**Trigger surface:** API unit fixtures that replace the config module, including shared fixture factories.

**Incident:** The November 3 release gate could not load four additional fixtures after Git object-store code imported `childProcessEnv`. Partial module mocks omitted that export. KRTX-3974 preserves it without changing production code or assertions.

**Enforcement:** Run the Teams settings authorization, gateway usage deadline, create-session drain error, and public-app tests with Bun 1.4.3, `--isolate`, and `scripts/test.env`. Before the fix: 0 pass, 4 fail. After: 76 pass, 0 fail.
