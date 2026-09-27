---
recorded: 2026-09-27T03:42:33Z
incident_date: 2026-09-26
---
# A one-shot decision at boot hardens forever on a box that resumes instead of rebooting

**Rule:** anything a sandbox decides ONCE — a catalog fetch, a capability probe,
an install path, a "this release failed" verdict — must be re-derived, because a
Platinum box is suspended and resumed rather than rebooted and boot-only code
never runs again. A failure is a timestamped attempt, never a verdict.

**Trigger surface:** adding a boot-time fetch or probe in
`apps/kortix-sandbox-agent-server`; writing a quarantine, a `failed` component
state, or any "we already tried" record that nothing expires; assuming a wake or
a restart re-runs boot.

**Incident (dev, one project, 2026-09-26):** five failures, one shape.
(1) `[boot] managed reconcile: no live managed set; bundled managed models
stand` — one failed fetch, so the daemon's BUNDLED model lineup stood for a
month. (2) A config-release candidate SIGTERMed by the daemon's own
`agent-swap` shutdown 815 ms after spawn was recorded as a release failure and
quarantined on that box. (3) `CLI replace failed: EACCES … /usr/local/bin/…` on
a non-root daemon, retried identically every reconcile with nobody told.
(4) `agent swap deferred — live work in progress {"name":"pty"}` forever,
because one shell was left open. (5) `uptime_s: 2663144` (30.8 days) on a box
"woken" that morning. End state, measured: after the managed lineup rotated the
session had NO model both sides accept — `PUT /sessions/:id/model` with an id
the box knows answered `400 INVALID_SESSION_MODEL`, the ids the API serves were
absent from the box, and every prompt returned `500 UnknownError`. A restart did
not repair it; only a new session escaped. A sweep of 14 sessions across two
projects: 12 of 14 boxes had no `config.release.v1`, 3 of 14 served the current
model lineup.

**The four rules.** (1) Quarantine requires evidence the artifact itself failed
— a candidate killed by our own shutdown is not evidence — and always expires.
(2) A cause that can never succeed escalates to a visible `blocked` state
instead of retrying in silence. (3) Convergence runs on boot, resume (detect it
by wall-clock against monotonic uptime), turn start and a periodic floor, and
two convergence lanes may not race. (4) A box proves its capability, its
daemon-build floor and its catalog fingerprint before a session is handed to it,
or it is replaced.

**Enforcement:** contract in `docs/specs/runtime-convergence.md` (PR #7785);
implementations #7792 (box side), #7793 (API side, admission enforcement
default-OFF until boxes report), #7791 (swap/convergence race and the
self-inflicted quarantine), #7786 (catalog). Acceptance is five self-heal
scenarios on a DEPLOYED target — the local profile cannot boot a sandbox, so a
green local run proves none of them. Those flows do not exist yet; until they
do, this rule has a contract and no enforcer.
