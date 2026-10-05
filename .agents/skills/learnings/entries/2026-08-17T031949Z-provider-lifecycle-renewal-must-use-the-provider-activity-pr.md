---
recorded: 2026-08-17T03:19:49Z
incident_date: 2026-08-17
commit: 97fa3aef20
---
# Provider lifecycle renewal must use the provider activity primitive

**When:** implementing provider-neutral lifecycle renewal. Use the provider's native activity or deadline API. Do not assume a guest command updates the provider lifecycle clock. Reject renewal unless the provider reports the sandbox as running.
*Incident:* Daytona accepted repeated `true` guest commands while its one-minute native autostop clock continued unchanged. The sandbox stopped 21 seconds before Kortix `deadline_at` during deterministic lifecycle testing.
*Enforcer:* `daytona.test.ts` requires `refreshActivity()`, rejects stopped sandboxes, propagates failures, and bounds a hung refresh. The live provider harness forces a one-minute native timer.
