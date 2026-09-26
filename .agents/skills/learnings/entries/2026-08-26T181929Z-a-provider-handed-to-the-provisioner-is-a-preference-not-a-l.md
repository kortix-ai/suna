---
recorded: 2026-08-26T18:19:29Z
incident_date: 2026-08-26
commit: 82235c6856
---
# A provider handed to the provisioner is a PREFERENCE, not a lock

**When:** passing a sandbox provider into `provisionSessionSandbox`, or reading
one back to decide whether failover may run. Only an explicit `body.provider`,
an enabled per-project pin, or a restart on an existing box locks the runtime.
The weighted balancer's pick must stay unlocked, or admin-gated failover is dead
code for every session that never asked for a provider by name. *Incident:*
`platform_settings.provider_fallback` was ON in prod, yet 654 sessions died on a
provider at capacity in one hour with ZERO handoffs recorded in
`session_sandboxes` — `createProjectSession` forwarded the balancer's pick and
the provisioner read any provider as explicit. *Enforcer:*
`apps/api/src/projects/lib/sessions.provider-failover-wiring.test.ts` fails if
either end stops honoring `providerLocked`.
