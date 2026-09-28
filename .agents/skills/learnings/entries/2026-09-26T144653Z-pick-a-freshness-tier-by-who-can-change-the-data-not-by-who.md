---
recorded: 2026-09-26T14:46:53Z
incident_date: 2026-09-26
---
# Pick a freshness tier by who can change the data, not by who usually does

**Rule:** Choose a `FRESHNESS` tier in `@kortix/sdk/react` by who CAN change
the entity. `config` claims every change arrives through this app's own
mutations. If an agent, the CLI, a teammate, or another tab can change it, a
page that must stay current uses `directory` (refetch on focus and every 10 s
while visible).

**Trigger surface:** Adding or editing a `FRESHNESS` entry, or passing `contract(...)` to a
page-level `useQuery`.

**Incident:** 2026-09-26 prod, reported by a user: the Connectors page Connected tab
showed a connector added by an agent, a setup link, or another tab only after a
browser reload. Its list used `contract('config')`; focus refetch is off
app-wide and the page's top-level query never remounts. On dev the page made 0
list requests in 30 s after an out-of-band add. PR #7736.

**Enforcement:** `packages/sdk/src/react/query-contracts.test.ts` pins
`FRESHNESS.connectors === 'directory'` and its focus and interval refetch.">
