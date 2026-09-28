---
recorded: 2026-09-16T21:50:41Z
incident_date: 2026-09-16
commit: 556ec0ec1a
---
# Verify pre-create settings in the session create request

**When:** adding a setting that the new-session composer must carry into
`POST /sessions`. Keep the selection in composer-owned state. Assert the
outgoing create body and session read-back after the visible control changes.

**Near-miss (PR #7319):** the Provider keys panel showed two selected keys,
but its local draft never reached the composer. A warm session was claimed
without a pool. The preview browser caught this before merge.

**Enforcement:** browser journey 30 checks selected IDs in the create request.
The warm-session unit test rejects a create body with `provider_secret_pools`.
