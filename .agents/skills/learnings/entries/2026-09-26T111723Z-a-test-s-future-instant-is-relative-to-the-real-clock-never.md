---
recorded: 2026-09-26T11:17:23Z
incident_date: 2026-09-26
---
# A test's future instant is relative to the real clock, never a literal date

**Rule:** When a test needs an instant that is AFTER a row the test itself just
wrote, compute it from the real clock — `new Date(Date.now() + <delta>)`. Write
a literal date only where every input is injected and nothing is compared
against wall-clock now. A literal "future" date is a timer: it is correct until
the wall clock passes it, then the suite is red with no code change.

**Trigger surface:** any test that writes a row whose timestamp column defaults
to `now()` and then passes an explicit `now` into the code under test — the
session-lifecycle command queue, trigger schedules, billing holds, any
`available_at` / `due_at` / `expires_at` claim. The tell is a literal date
constant near a helper that inserts without injecting its own clock.

**Incident:** 2026-09-26. `apps/api/src/__tests__/integration-lifecycle-command-lease.test.ts`
held `const LATER = new Date('2026-09-26T10:00:00.000Z')`, described as "far
enough ahead that every parked row is due for the next claim". `enqueue()`
writes `available_at` at wall-clock now; `claimDueLifecycleCommands` selects
`available_at <= now`. Once real time passed 10:00Z the claim matched nothing,
`const [held] = await claim(...)` bound `undefined`, and
`parkPromptForUnreachableRuntime` threw
`TypeError: undefined is not an object (evaluating 'lease.commandId')` at
`apps/api/src/projects/session-lifecycle/store.ts:960`. Four tests in
"a prompt whose runtime is unreachable" went red. Blast radius: the `db-suites`
lane, so the `core` lane, so `main` itself and every PR branched from it. Run
36202098410 at 2026-09-25T23:43Z was green; run 36236285805 at
2026-09-26T10:36Z was red, on production code that no commit had touched. The
product was never broken. Fix: `LATER` is now `Date.now() + 86_400_000`.

**Enforcement:** none yet. A static rule cannot simply ban literal dates in
tests — `apps/api/src/projects/trigger-schedule.test.ts` uses them correctly,
because `initialTriggerScheduleSlot` takes its `now` as an argument and touches
no wall clock. The enforcer to build is narrower: flag a literal date constant
in a test file that ALSO inserts a row through a helper which does not inject
that same clock. Until it exists, the review question is the one that catches
it every time — "is this date still in the future next month?"
