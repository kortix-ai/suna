---
recorded: 2026-08-26T14:11:26Z
commit: ba67f3f702
---
# A retry that inherits the previous attempt's budget is not a retry

*Incident (2026-08-26, SampleCo, session `29861dfa` / box `inqwpv4a`).* The
first production outing of the automatic wake-cooldown ladder (see "A stamped
failure is a cooldown, never a gravestone") defeated itself.

Attempt 1 failed at ~13:27 in a post-roll build storm. The cooldown rung
re-attempted at ~13:33: the resume launched the entrypoint, the daemon booted
through 13:34:48.8, authenticated to the gateway at 13:34:48.5–49.1 and claimed
its initial turn at **13:34:49.216** — and `/start` parked the box at
**13:34:49.202**. The boot lost by **14 ms**.

`opencodeBootWaitFirstSeenAt` was stamped during attempt 1 and cleared by
nothing: `parkEstablishedRuntime` copies the whole metadata object, the wake
claim stripped only four of the ten readiness-clock keys, and
`clearRuntimeReadinessClocks` stripped the first eight **by hardcoded index**.
Only a human Restart (`prepareInPlaceRestartMetadata`, which loops the whole
list) cleared it. So the 10-minute hard cap was ~7 minutes old before attempt 2
started booting, and **every automatic rung after the first five minutes was
deterministically doomed, regardless of progress.**

**The rules.**

1. **Every automatic retry re-baselines the same clocks a human retry does.** An
   attempt judged against a predecessor's budget is not an attempt. The only
   thing an automatic rung keeps that a human restart clears is the
   consecutive-failure accounting that drives its own escalation.
2. **Never write a key list twice.** The four/eight/ten split existed because
   three call sites hand-wrote `- 'key'` chains. Generate every chain from the
   single exported list; index-addressed subsets (`KEYS[0] … KEYS[7]`) silently
   stop covering a list that grows.
3. **Scope a budget to its attempt, causally.** `staleOpencodeReadyReason` now
   ignores any clock stamped before this attempt's boot epoch
   (`runtimeBootEpochMs` = newest of `runtimeWakeStartedAt`,
   `providerRunningConfirmedAt`, `initSucceededAt`). This is **not** a
   progress reset: a stub launcher that changes phase for ever is still caught
   at the cap, because only a NEW attempt moves the epoch. Do not "fix" an
   inherited budget by making the hard cap progress-aware — that undoes
   "A boot budget measures lack of progress, not wall-clock".
4. **`jsonb - $1` is ambiguous; strip keys as literals.** Postgres cannot
   choose between `jsonb - text` and `jsonb - integer` for an untyped
   parameter. A bind-parameter strip inside a `try/catch` that only
   `console.warn`s fails invisibly — which is the likeliest reason the
   ready-path clear never cleared anything in production.

*Automation:* `session-lifecycle/readiness-clocks.test.ts` — "an automatic rung
never inherits the previous attempt boot budget" (including "a stub
launcher that changes phase for ever is still caught at the cap" and
"who resets the retry accounting"); `e2e-project-session-contract.test.ts` —
"the automatic rung re-baselines the boot clocks but KEEPS the failure
accounting".
