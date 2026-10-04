---
recorded: 2026-09-30T16:30:09Z
incident_date: 2026-09-30
---
# Apply a new list filter to every row a list appends after its query, not only to the query

**Rule:** When you add a filter to `GET /projects/:id/sessions` (or any list),
check every step that adds rows AFTER the filtered query. The flat session list
appends each listed child's missing coordinator as tree context
(`loadProjectSessionInventory`, `MAX_ANCESTOR_DEPTH` loop), outside `filterSql`.
A filter that promises "only rows that match" must skip that append or apply
itself to it. Add the filter to the cursor's `filter` seal in the same change.

**Trigger surface:** adding a query parameter to `SessionListFilter` /
`sessionListFilterSql` in `apps/api/src/services/sessions/session-list.ts`, or to any
list route that post-processes its page (ancestors, pinned rows, the caller's
own session).

**Incident:** 2026-09-30, near-miss on dev, #8249 (session labels). Dev
verification ran `kortix sessions ls --label <a> --label <b>` inside a real
sandbox. It returned the coordinator, which carried only `<a>`, next to the
worker that carried both. `SESS-38` covered `parent=root` and never the flat
list. Fixed in #8469 (`bb63b30a06`) before any promote. The web and MCP were
never affected (they send `parent=root`). No prod impact.

**Enforcement:** `SESS-38` step "a flat list filtered by label never adds an
unlabeled coordinator as tree context" (`tests/src/flows/sessions.flow.ts`).
A future filter needs its own flat-list step; nothing enforces that generically
yet.
