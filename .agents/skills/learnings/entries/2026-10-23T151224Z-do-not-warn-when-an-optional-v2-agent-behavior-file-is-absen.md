---
recorded: 2026-10-23T15:12:24Z
incident_date: 2026-10-23
---
# Do not warn when an optional v2 agent behavior file is absent

**Rule:** Treat an absent v2 behavior file as supported governance-only configuration. Keep transport and malformed-content diagnostics.

**Trigger surface:** Compiling v2 project agents during release or reload.

**Incident:** 2026-10-23, KRTX-3388: successful releases warned for agents without optional markdown. The compiler already supports this state.

**Enforcement:** apps/api/src/projects/lib/compile-agent-config.test.ts asserts missing markdown compiles without warning and transport failures return null.
