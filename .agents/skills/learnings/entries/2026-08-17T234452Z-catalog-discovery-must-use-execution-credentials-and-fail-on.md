---
recorded: 2026-08-17T23:44:52Z
incident_date: 2026-08-18
commit: 7399616a71
---
# Catalog discovery must use execution credentials and fail on upstream errors

**When:** materializing a remote connector catalog, especially MCP
`tools/list`. Resolve the same effective connection credential and static
headers used by tool execution, including OAuth refresh. Reject non-2xx,
protocol-error, and malformed responses; persist a safe error instead of an
apparently healthy empty catalog. Re-run discovery after credentials change,
and never include raw or encoded credential material in diagnostics.
*Incident:* SampleCo Dev Sage Intacct authenticated successfully and exposed
four MCP tools, while Kortix sent no credential, parsed an empty HTTP 401 body,
and materialized zero actions without an error.
*Enforcer:* `sync-mcp.test.ts`, `unit-connector-call.test.ts`, and
`oauth2.test.ts` cover authenticated discovery, refresh/rematerialization,
HTTP/JSON-RPC failures, and credential redaction.
