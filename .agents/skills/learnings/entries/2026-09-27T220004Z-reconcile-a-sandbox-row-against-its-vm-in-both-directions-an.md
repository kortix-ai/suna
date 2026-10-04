---
recorded: 2026-09-27T22:00:04Z
incident_date: 2026-09-27
---
# Reconcile a sandbox row against its VM in both directions, and never repair a box with its own credential

**Rule:** Every sweep that judges a sandbox owns ONE row-status class and must
close its divergence in both directions. A parked row over a running VM is a
divergence, not "still there". A repair authenticates with a credential the
control plane mints at repair time, never with the box's own token — the token
a wrong row has already killed. A box never converts a control-plane error into
a terminal state of its own.

**Trigger surface:** any reaper or sweep over `session_sandboxes`, any provider
fleet listing, the legacy-runtime repair script, and any daemon-side circuit
breaker that can end the process.

**Incident:** A wrong `stopped` row kills the live box's credential, because a
session token is refused unless its sandbox row is `provisioning`/`active`. The
daemon's dead-token breaker then shut itself down with exit 0, which the
entrypoint reads as an intentional stop and never relaunches — a running VM
serving nothing, which the control plane still accepted prompts against. The
repair could not fix it either: the script fetched its manifest with the box's
dead token. Measured on dev: 2 of the 3 running boxes in the fleet had a parked
row, one divergence 31.8 days old. Reproduced end to end on a throwaway
session and closed by PR #7861.

**Enforcement:** `apps/api/src/services/sandboxes/reaping/row-vm-divergence.test.ts`,
`apps/api/src/services/projects/lib/legacy-runtime-dead-daemon.test.ts`,
`apps/api/src/services/projects/lib/legacy-runtime-repair-credential.test.ts`,
`apps/api/src/__tests__/integration-sandbox-ownership.test.ts` (real PostgreSQL
and provider HTTP), and
`apps/kortix-sandbox-agent-server/src/__tests__/session-token-health.test.ts`
(the breaker reports and recovers, and never ends the daemon).
