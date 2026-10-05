---
recorded: 2026-09-02T14:20:46Z
incident_date: 2026-09-02
commit: 4bec78979f
---
# A second runtime per session inherits none of the first one's reconcilers, and a status column nobody writes is a permanent wedge

**When:** giving a session a second box — a pi environment, or anything else
that gets its own table instead of a `session_sandboxes` row. Every reconciler,
sweep, meter and stop path in this repo keys on `session_sandboxes`, and a new
table silently opts out of all of them at once. Grep for the table name across
`billing/`, `reaping/` and `session-lifecycle/` before assuming a lifecycle is
wired; `stopX`/`deleteX` existing and being CALLED from the manual paths proves
only the manual paths.

**The wedge:** `session_environments.status` had exactly one writer
(`stopSessionEnvironment`, reachable only from the manual Stop and its route),
while the box carried `autoStopInterval: 60`. So the provider powered boxes off
and nothing wrote it down. `ensureSessionEnvironment` short-circuited on
`status === 'active' && externalId`, and `claimEnvironmentWork` re-claims only
`error`/`stopped`/stale `provisioning` — never `active`. A stopped box therefore
served forever from a row that could not be re-claimed: every tool call failed
and nothing in the system could repair it. **20 of 21 rows on pi.kortix.com read
`active` with a box attached.**

**The rules:** (1) any status column a PROVIDER can change behind your back must
be verified against the provider before it is trusted, not just written on the
paths you control; (2) `unknown` from an unreachable provider must not
authorize a teardown — serving stale is the recoverable mistake (the same split
`providers/status.ts` records as "the single most expensive bug in this
subsystem"); (3) a new runtime table needs its billing join, its stop-path
write, and its reaper entry added deliberately — `startComputeSession` defaulting
`workloadType` to `'session'` for a non-session box makes the invariant sweep
close its meter on the first pass. Measured: 21 environments, ONE compute row,
88.5 s, $0.0049 total.

*Scope:* found by a 55-agent audit — 49 candidate sites, 28 confirmed — recorded
in `docs/PI_P24_SCOPE.md`. The wedge and the reaper tie-in are fixed; billing
(needs a `workload_type` CHECK migration) and the automatic stop paths are not.
*Enforcer:* `environment-liveness.test.ts` pins the decision, and
`routes/session-environment.test.ts` pins that `ensure` actually calls it.
Nothing yet asserts that a new runtime table appears in the billing sweep.
