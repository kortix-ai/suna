---
recorded: 2026-09-15T06:42:47Z
incident_date: 2026-09-15
commit: aada3f2a08
---
# Count browser document loads only after the initial page reaches `load`

**When:** counting loads in a Playwright journey after `page.goto` waits only for `domcontentloaded`. Wait for `page.waitForLoadState('load')` before recording the baseline. The initial page's late `load` otherwise counts as a navigation caused by the next click. *Near-miss:* the v0.13.15 local release gate reported a false hard reload while every per-click sentinel survived. *Enforcer:* `tests/e2e/specs/24-no-hard-navigation.spec.ts` waits at both count boundaries.
