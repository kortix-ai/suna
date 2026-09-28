---
recorded: 2026-09-15T23:29:15Z
incident_date: 2026-09-15
commit: ab46fb9d57
---
# Let Docker readiness decide whether a sandbox can run the preview

**When:** preparing a Daytona warm image, attempt kernel module loads but do not
abort on a denied `modprobe`. Require the bounded `docker info` gate to pass.
*Incident:* PR #7267's fallback stopped on `iptable_nat: Operation not permitted`;
the same base image started Docker and pulled Supabase images with this check.
Platinum's earlier `503 body-budget-exhausted` came from its public proxy, not
Kortix. Inspect response bodies before attributing preview failures to the app.
*Enforcer:* `daytona-ci.test.ts` requires advisory module loads and Docker readiness.
