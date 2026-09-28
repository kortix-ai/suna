---
recorded: 2026-09-16T11:00:12Z
incident_date: 2026-09-16
commit: 0b9a626ce5
---
# Test Entra's actual SCIM PATCH payloads

**When:** parsing SCIM user or group updates. Normalize Entra string booleans,
case-insensitive attributes, and pathless attribute objects. A removal value
array selects members; only an omitted value and filter mean remove all.
*Incident:* dev investigation reproduced ignored user deactivation and removal
of unrelated group members. *Enforcer:* HTTP flows `SCIM-6` and `SCIM-7` prove
deactivation, last-owner protection, selective removal, and persisted read-back.
