---
recorded: 2026-08-26T13:06:00Z
commit: 97b81a45d1
---
# A stamped failure is a cooldown, never a gravestone — and a negative is a claim

*Incident (2026-08-26, SampleCo).* Two sessions could only be recovered by a
human pressing Restart.

- Session `e06ad0c4` answered `POST …/start` with `stage:"failed"` in **47 ms**,
  making **no provider call**. A wake had exceeded the FIXED
  `RUNTIME_WAKE_LEASE_MS = 240_000`, and maintenance stamped
  `stopReason:"runtime_wake_failed"`. The box was startable: the manual restart
  reached ready in **10 s**.
- Session `9c8749ac` (box `i67m4fhw2t3nesssgl4yf`) replayed
  `{"stage":"failed","retriable":false,…"stopReason":"runtime_boot_failed",
  "healthStatus":"unknown","lastInitError":null}` on **every open for 10+
  hours** from a stamp written at 03:37Z. Four fields from four different
  writes; none described the call, which touched nothing.

Both stamps were written by a budget that measured wall clock, and both were
consumed by a `/start` branch that returned before any provider call. Only
`POST …/restart` cleared them, which is why the human's one click always worked.

**The rules.**

1. **A stamped runtime failure suppresses re-attempts for a COOLDOWN, and for
   nothing longer.** After it lapses the next `/start` re-attempts by itself.
   The cooldown escalates with consecutive failures (2 / 5 / 10 min) so a broken
   provider is not hammered, and the verdict expires 30 min after the last
   failure: no verdict outlives its evidence.
2. **Cover every stamp that short-circuits the path**, not the one in the
   report. `runtime_wake_failed` AND `runtime_boot_failed` produced the same
   dead end from two different writers.
3. **`retriable` is derived on every call, never persisted.** Anything the
   server can still re-attempt must not answer `retriable:false` — that flag
   tells the client's escalation ladder to stop.
4. **A negative is a claim: carry its evidence.** Every `/start` failure now
   ships `failure.evidence` = which check, when it ran, the provider text, the
   attempt count, and `next_retry_at`. A `failed` payload with
   `lastInitError:null` tells a user nothing.
5. **The answer states what THIS call did and observed.** `action`,
   `observation` (with `known:false` meaning NOT CHECKED, never "checked and
   unknown"), `boot.actively_starting`, and one `observed_at`. A payload no live
   check supports is not a state worth naming.
6. **The wake budget measures lack of progress** — the same rule as
   "A boot budget measures lack of progress, not wall-clock". A provider-state
   change restarts the 90 s no-progress budget and refreshes the durable lease;
   `RUNTIME_WAKE_HARD_MS = 10 min` bounds the whole wake and never restarts, so
   the reconcile/billing exemption that lease grants can never be held open by a
   flapping provider.
7. **The observer that DEFERS a park owns the confirmation.** A mid-turn
   `stopped` read that waits for a second observation must schedule that second
   read itself, not assume someone polls again. Session `29861dfa` /
   `inqwpv4a1cc1kynlg46k8` read `running` for 5+ minutes while the provider said
   `not running (status: stopped)`, and the queued prompt burned against it.

*Automation:* `apps/api/src/projects/routes/stopped-wake-result.test.ts` (the
10-hour replay, both stamps, the ladder, the evidence),
`session-lifecycle/runtime-wake-fence.test.ts` (progress-aware budget, hard cap,
cooldown ladder, the lease boundary), `reaping/sandbox-state-sync.test.ts`
(the 2026-08-17 mid-turn park needs a confirmed second stopped read),
`projects/sandbox-reaper.test.ts` (`decideComputeClose`: a fresh wake fence is
not billable-stop proof),
`session-lifecycle/stopped-observation-followup.test.ts` (bounded confirmation),
`session-lifecycle/start-envelope.test.ts` (one envelope per open state).
