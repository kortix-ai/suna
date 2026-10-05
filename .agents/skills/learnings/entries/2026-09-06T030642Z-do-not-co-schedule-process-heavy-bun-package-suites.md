---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-05
commit: 3caec60726
---
# Do not co-schedule process-heavy Bun package suites

**When:** scheduling package tests in the root gate. Run the CLI and sandbox-agent
suites as separate bounded steps. Their concurrent isolated Bun workers can spin at
100% CPU and stall the gate. *Near-miss:* two full runs exceeded 9 minutes in the CLI
worker; the same CLI suite passed alone in 40.80 seconds. *Enforcer:*
`test-runner-contract.test.ts` and the serialized `package-quality.ts` wave.
