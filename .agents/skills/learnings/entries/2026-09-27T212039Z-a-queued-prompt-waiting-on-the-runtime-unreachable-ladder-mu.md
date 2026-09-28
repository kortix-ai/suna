---
recorded: 2026-09-27T21:20:39Z
incident_date: 2026-09-27
---
# A queued prompt waiting on the runtime-unreachable ladder must extend its box's deadline

**Rule:** A queued prompt is control-plane-authored evidence that a turn is
about to run, so it must extend its target box's deadline every time the
control plane commits to retrying it — the same "control-plane-OBSERVED
event" vocabulary every other grant in `sandbox-deadline-policy.ts` follows.
Do not add a parallel "does this box have an undelivered prompt?" check to
the reaper instead: the reaper's contract is one comparison
(`deadline_at <= now()`), and a second, cross-table carve-out fights that
design for no benefit the deadline model doesn't already give for free.

**Trigger surface:** writing or reviewing anything in the runtime-unreachable
retry ladder (`parkPromptForUnreachableRuntime`, `reArmRuntimeBlockedPrompts`
in `session-lifecycle/store.ts`) or the box's own deadline grants
(`sandbox-deadline-policy.ts`, `sandbox-deadline.ts`). Applies whenever a
prompt can sit queued, unattempted, for longer than the box's shortest
possible deadline (the 15-minute resume floor).

**Incident:** dev, 2026-09-27. A queued prompt's first delivery attempt
failed while a just-woken box's daemon was still restarting
(`reason: runtime_unreachable`). `parkPromptForUnreachableRuntime` parked it
with the standard 30 s / 120 s / 480 s backoff, but a queued prompt holds no
turn record — a `delivering` entry is only created once a prompt actually
reaches the daemon — so nothing kept the box's 15-minute boot-floor deadline
from expiring while the prompt waited out its own backoff. The reaper
reaped the box at `20:26:46Z` and again at `20:56:46Z`; each retry that
landed on a reaped box read the session status as `stopped`, returned
`unreachable` immediately, and burned another rung of the ladder proving a
box the platform itself had just switched off was down. The prompt only
went out because a human called `/start` by hand in between. Fixed in
PR #7860 by extending the box's deadline (`promptRetryGraceMs()`, 15 min)
from inside `parkPromptForUnreachableRuntime` on every park, reusing the
existing `extendSandboxDeadline` writer (monotone, capped at
`NON_TURN_DEADLINE_CAP_MS`, a no-op for a box the reaper already stopped).
Bounded a second way by `MAX_RUNTIME_UNREACHABLE_RETRIES` (3): a park can
only ever re-issue the grant 3 times before the row dead-letters, so a
poisoned prompt still cannot hold a box alive forever.

**Enforcement:** `integration-lifecycle-command-lease.test.ts` — "parking a
prompt extends its still-active box past the retry ladder" (real Postgres,
real anchor-guard trigger, real `extendSandboxDeadline` SQL) and "parking a
prompt for a stopped box does not touch its deadline" (proves the grant
cannot revive a box the reaper already stopped).
