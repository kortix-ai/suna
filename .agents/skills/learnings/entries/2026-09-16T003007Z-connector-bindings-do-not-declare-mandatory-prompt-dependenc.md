---
recorded: 2026-09-16T00:30:07Z
incident_date: 2026-09-15
commit: 788be881d0
---
# Connector bindings do not declare mandatory prompt dependencies

**Incident.** The production incident above persisted after the agent's Gmail
requirement was removed. Prompt preflight promoted every stored binding into a
mandatory dependency. A disabled optional connector blocked unrelated messages.

**Rule.** Only explicit session `require_connectors` and running-agent
`connectors_required` gate prompts. Bindings select connections. Check optional
connector availability when that connector is called. Preserve connector-call
authorization and explicit requirement gates.

**Enforcement.** `prompt-connector-preflight.test.ts` rejects implicit binding
requirements. `SESS-29` stores a disabled bound connector, admits a prompt through
HTTP, verifies the inbox row, then explicitly requires the same connector and
asserts a 409 refusal.
