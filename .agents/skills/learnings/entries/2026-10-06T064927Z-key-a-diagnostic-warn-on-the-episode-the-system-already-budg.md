---
recorded: 2026-10-06T06:49:27Z
incident_date: 2026-10-04
---
# Key a diagnostic warn on the episode the system already budgets, not on the state delta it reports

**Rule:** When a poll loop warns to diagnose a recurring condition, gate the warn
on the EPISODE (a spell, a boot, a wake) and on the budget that episode already
has — one warn when the episode outlives the budget, never one warn per observed
state change. A gate on "the field changed" re-fires every time a transient
condition alternates between two values, which is what a healthy recovery looks
like.

**Trigger surface:** Any warn inside a poll/retry loop whose gate compares the new
observation with the last recorded one — a cause, a phase, a reason, a status.
Here `stampUnreachableDiagnostics`
(`apps/api/src/projects/session-open/session-open-readiness.ts`) and the spell
clock it shares with the boot budget
(`apps/api/src/projects/session-lifecycle/readiness-clocks.ts`).

**Incident:** 2026-09-29, PR #8183 replaced one-warn-per-poll (1119 lines/hour
from 20 stuck sessions) with one-warn-per-CHANGED-cause. That fixed the stuck
case and created a new one: a cold wake alternates `timeout_or_network` /
`http_502` while the restored microVM binds its port, and every flip is a "new"
cause — 816 warns in one day (2026-10-04, 14 boxes), consecutive pairs 11 s
apart, 73% of spells over inside the 30 s ride-out budget the open path itself
enforces. The 2026-09-28 audit-queue case (KRTX-614) is the same failure one
level up: the throttle interval, not the retry, defines the episode.

**Enforcement:** `shouldWarnRuntimeUnreachable — one warn per unreachable spell
past its ride-out budget` in
`apps/api/src/projects/session-lifecycle/readiness-clocks.test.ts` (zero warns
inside the budget; one at the crossing; one per spell, not per flip), and the
silence-under-flips assertions in
`apps/api/src/projects/session-open/session-open-readiness.test.ts`. Both fail
against the cause-change gate.
