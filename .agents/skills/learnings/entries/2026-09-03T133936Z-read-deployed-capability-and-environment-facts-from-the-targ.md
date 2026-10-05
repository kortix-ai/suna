---
recorded: 2026-09-03T13:39:36Z
incident_date: 2026-09-03
commit: 61934a1acb
---
# Read deployed capability and environment facts from the target, not the runner label

**When:** writing browser assertions for a deployed preview, staging, or production target.
**Incident:** the Pi gate called its target `custom`, while `/v1/health` correctly reported
`preview`; another test required Platinum even though the target exposed Daytona only.
**Rule:** read the environment and available providers from target responses, then assert the UI
renders that exact contract. Do not translate runner labels or hard-code optional providers.
**Enforcer:** `18-apps-ui.spec.ts` reads health; `12-sandbox-templates.spec.ts` reads provider coverage.
