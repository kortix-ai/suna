---
recorded: 2026-10-13T11:54:49Z
incident_date: 2026-10-06
---
# Verify persisted revocation before printing CLI success

**Rule:** Reuse the web revoke operation and read persisted revoked status before emitting CLI success. Fail closed when acknowledgement or read-back cannot prove it.

**Trigger surface:** Connector cleanup through `connectors connections revoke`.

**Incident:** 2026-10-06, KRTX-1664: a synthetic dogfood connection stayed active after CLI success while web Disconnect worked. Original network traffic was not captured; the historical mutation failure remains unknown.

**Enforcement:** `apps/cli/src/__tests__/connectors-revoke.blackbox.test.ts` rejects false success with real CLI processes; `CONN-21` verifies persisted state and accounts removal on the local stack.
