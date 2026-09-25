---
recorded: 2026-08-22T20:04:06Z
incident_date: 2026-08-22
commit: 6479d6ae82
---
# Prove the gated query ran after enabling its feature

**When:** enabling a feature on one page, then navigating to its data page in a
browser test. A route render does not prove the gated query ran. Wait for the
exact API response around an explicit reload before asserting its empty state.
*Near-miss:* release PR #6746 browser shard 2 failed twice with a permanent Apps
skeleton after a `200` feature PATCH and zero `GET /apps` requests. *Enforcer:*
`18-apps-ui.spec.ts` requires the Apps list response before the empty state.
