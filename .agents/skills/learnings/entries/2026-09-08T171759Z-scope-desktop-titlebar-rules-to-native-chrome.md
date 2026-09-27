---
recorded: 2026-09-08T17:17:59Z
incident_date: 2026-09-08
commit: d36a8903b4
---
# Scope desktop titlebar rules to native chrome

**When:** editing shared navigation, tabs, sidebars, or fullscreen overlays.
Never size or drag every tab list. Preserve native titlebar clearance when
adding inline header padding. Reserve a non-shrinking spacer in fullscreen overlays.
*Incident:* desktop-cleanup reproduced a workspace selector at y=7.36px under
the traffic lights. Global tab-list heights collapsed settings and agent groups.
*Enforcers:* `window-chrome.test.js`, `desktop-titlebar.test.ts`, and
`tests/e2e/specs/27-desktop-parity.spec.ts` (Chromium and native Electron).
