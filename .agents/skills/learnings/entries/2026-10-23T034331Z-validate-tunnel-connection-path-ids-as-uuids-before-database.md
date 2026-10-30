---
recorded: 2026-10-23T03:43:31Z
incident_date: 2026-10-23
---
# Validate tunnel connection path IDs as UUIDs before database access

**Rule:** Validate UUID-backed tunnel path parameters with the route schema before querying PostgreSQL.

**Trigger surface:** Connection read, rename, unpair, token rotation, and access routes.

**Incident:** On 2026-10-22, malformed synthetic IDs caused seven prod 500 responses with SQLSTATE 22P02 (KRTX-3217).

**Enforcement:** TUN-1 sends a malformed ID to all five endpoints and requires 400; valid missing IDs remain 404.
