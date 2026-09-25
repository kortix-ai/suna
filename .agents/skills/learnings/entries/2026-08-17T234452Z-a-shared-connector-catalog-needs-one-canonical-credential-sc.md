---
recorded: 2026-08-17T23:44:52Z
incident_date: 2026-08-18
commit: 7399616a71
---
# A shared connector catalog needs one canonical credential scope

**When:** rematerializing a credential-dependent connector catalog. Only the
project-default credential may write project-wide `connectorActions`. Never use
a member-owned or non-default connection credential. Store catalogs per
connection before supporting credential-specific action sets.
*Incident:* Strix found that PR #6507 let a member MCP credential overwrite the
shared project catalog and expose tenant-specific tool metadata before merge.
*Enforcer:* `sync-mcp.test.ts` rejects member and non-default rematerialization.
