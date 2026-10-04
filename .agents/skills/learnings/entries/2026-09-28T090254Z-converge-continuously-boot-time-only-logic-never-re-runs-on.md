---
recorded: 2026-09-28T09:02:54Z
incident_date: 2026-09-28
---
# Converge continuously: boot-time-only logic never re-runs on a provider that resumes

**Rule:** When you place a convergence step at "the one chokepoint every
provisioning path shares", you have covered COLD BOOT ONLY. Platinum suspends
and resumes a VM instead of rebooting it, so a resumed box keeps the process
env, the config and the binaries baked in at its ORIGINAL provision — for
months. Before you call such a step done, name the path a RESUMED session takes
and prove the step runs on it too. If it does not, the row and the box drift
apart and stay apart, and the row is the one that looks right.

Its twin: when two budgets govern one operation, check them against each
other. A repair budgeted at 8 minutes behind a fence budgeted at 90 seconds is
not a slow repair — it is a repair that can never be observed to finish.

**Trigger surface:** adding or reviewing anything that runs "once per boot" —
`buildSessionSandboxEnvVars`, a config release, an asset manifest, a model pin,
a readiness or wake clock. Also any new park/timeout budget placed in front of
an existing repair.

**Incident:** 2026-09-28, PR #7957, dev. Sweeping one project's sessions for a
real user→assistant turn found two independent shapes with one cause.
(1) The runtime wake fence (`RUNTIME_WAKE_GRACE_MS`, 90 s) parked every legacy
repair (`LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS`, 8 min) that needed more than
90 s: one row showed a repair start at 08:17:58.513, a `runtime_wake_failed`
park at 08:20:15.322, and the repair still running until 08:26:08.293 — so the
platform spent ~6.5 minutes fixing a box it had already reported as `failed`.
#7954 had already fixed the SAME rule on the readiness clock; the second clock
was missed because fixing the first is what made the second visible.
(2) A retired managed model pin was re-pointed only on the provisioning path.
One session's row read `deepseek-v4-flash` while every message in its
transcript mirror — including one sent that morning — reported `grok-4.6`, the
model baked in five weeks earlier. Three values for one session: the row's pin,
the box's env, and OpenCode's own state. 108 of that project's 238 sessions
(45%) were pinned to a retired id, and a turn on a retired id cannot complete.

A third, smaller rule from the same hour: an error message must name every
condition its gate tests. The convergence timeout printed `klass/opencode`
while its gate tests four fields, so a box that failed on `runtimeBuild ===
null` reported `last: current/ok` — a reading that says "converged" beside the
words "not converged", and cost a diagnostic cycle.

**Enforcement:** `apps/api/src/projects/routes/wake-repair-grace.test.ts` pins
the repair-in-flight guard on the wake fence and was red-proofed against the
unfixed code (2 of 7 failed, on exactly the repair-in-flight cases; the 5 that
must still park passed both before and after).
`apps/api/src/services/sessions/session-model-repair.test.ts` and the
platform-default-floor block in
`apps/api/src/llm-gateway/resolution/session-model.test.ts` pin the model
repair. No enforcer exists for the general "does this also run on resume?"
question — that one is still a review question, and it is the one to build next.
