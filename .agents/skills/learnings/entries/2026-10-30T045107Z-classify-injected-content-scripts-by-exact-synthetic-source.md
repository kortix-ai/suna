---
recorded: 2026-10-30T04:51:07Z
incident_date: 2026-10-30
---
# Classify injected content scripts by exact synthetic source

**Rule:** Anchor extension-noise rules to observed synthetic script sources; preserve the same exception from first-party sources.

**Trigger surface:** Triage of browser onMessage TypeErrors.

**Incident:** 2026-10-30, KRTX-3704: an injected app:///js/content.js exception reached frontend telemetry. No Kortix bundle appeared in the captured stack.

**Enforcement:** apps/web/src/lib/browser-error-noise.test.mts exercises runtime and Sentry gates and first-party negative cases.
