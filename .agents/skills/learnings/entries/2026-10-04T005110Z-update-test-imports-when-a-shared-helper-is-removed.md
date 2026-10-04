---
recorded: 2026-10-04T00:51:10Z
incident_date: 2026-10-04
---
# Update test imports when a shared helper is removed

**Rule:** Update every test import when removing a shared helper. Keep assertions on the current source of truth.

**Trigger surface:** Removing exports used by package tests.

**Incident:** On 2026-10-04, the package gate fails because a web test imports the removed `visibleCapabilityTabs` export. The test now reads `CAPABILITY_TABS`, which the UI also renders. All assertions remain unchanged.

**Enforcement:** `pnpm exec bun test --isolate src/lib/menu-registry.flags.test.ts` in `apps/web` fails on a missing export. The repository packages lane runs the same test.
