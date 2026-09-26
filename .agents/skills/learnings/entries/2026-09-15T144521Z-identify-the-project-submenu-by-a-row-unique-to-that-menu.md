---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Identify the project submenu by a row unique to that menu

**When:** locating the open project picker in Playwright. Filter the menu by its `Account settings` row; accessible names for the trigger and nested menus can vary under Radix. *Near-miss:* the v0.13.15 local gate intermittently failed `20-workspace-switching` after clicking “Switch Project” because its named menu selector found no visible element. *Enforcer:* both `20-workspace-switching.spec.ts` and `24-no-hard-navigation.spec.ts` use the unique row.
