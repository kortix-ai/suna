---
recorded: 2026-09-10T17:14:57Z
incident_date: 2026-09-10
commit: ef74e50737
---
# Give a shared modal store exactly one active renderer

**When:** a page and its nested settings overlay both mount a global dialog.
Select one renderer at the deepest dialog depth. Concurrent Radix dialogs can
hide each other from the accessibility tree while both remain visibly open.
*Near-miss:* the 0.13.13 preview opened two billing dialogs from the account hub;
the checkout controls disappeared from Playwright's role locators.
*Enforcer:* billing browser journey asserts one accessible dialog, repeated
open/close, and Escape preserving the account hub.
