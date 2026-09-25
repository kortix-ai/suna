---
recorded: 2026-09-14T23:24:51Z
incident_date: 2026-09-14
commit: 88ca116084
---
# Assert settled dialog geometry before capturing a responsive screenshot

**When:** changing the viewport while a modal or select is opening or closing.
Wait for the target geometry and for dismissed dialogs to leave the DOM.
Disable animations for the screenshot itself. In PR #7234, a capture during
resize showed a 208px dialog; its settled mobile width was 390px. This nearly
triggered an unnecessary layout change. *Enforcer:* browser journey 28 asserts
mobile dialog width, awaits dialog removal, and disables capture animations.
