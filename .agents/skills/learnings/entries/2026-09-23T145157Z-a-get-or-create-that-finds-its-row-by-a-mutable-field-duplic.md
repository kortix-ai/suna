---
recorded: 2026-09-23T14:51:57Z
incident_date: 2026-09-23
commit: e880af26ed
---
# A get-or-create that finds its row by a mutable field duplicates the row once that field changes

**Rule:** When a get-or-create finds "its" row again, match on a field nothing
else writes: an id, or a marker the function stamps on create. Never match on a
user-editable value such as a label or name. Before you add a write to such a
field (a rename, a relabel), grep for every lookup that reads it.
**Near-miss:** `ensureMemberConnection` / `ensureDefaultConnection` found their
connector connection by its default label (`Private connection`, the connector
name). Adding a connection rename and an identity relabel at finalize would
have made every later connect insert a duplicate row. Found while building PR
#7557. They now also match `metadata.default_slot`, which Composio connect and
finalize carry forward. **Enforcer:**
`integration-connector-connected-as.test.ts`: 3 of 9 tests fail with the old
lookup.
