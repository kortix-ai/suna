---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# A runtime started from `stopped` owns no turn; settle and redeliver on the wake

*Incident (2026-08-25, SampleCo):* the provider paused two boxes mid-turn. One
was woken by the UI through the proxy before the reaper confirmed the stop:
the fresh runtime answered `idle`, the open turn closed `completed`, and the
user saw the agent "just stop" with nothing to resume. The other closed
`runtime_gone` but its accepted prompt was never redelivered (only
never-accepted deliveries were), so the user typed "go on".

**Rules.**
1. Every path that starts a provider-`stopped` box (`wakeSandbox` in the
   preview proxy, the `/start` wake finalize) calls
   `recoverTurnsAfterRuntimeRestart`: open ledger rows → `runtime_gone`,
   turn authority dropped, each prompt redelivered DUE (`hold:false`).
2. A stop the PROVIDER originated (`stopReason: provider_reconcile`) requeues
   accepted prompts too (held); a stop Kortix chose keeps the old rule.
3. A turn's verdict is never derived from a runtime that did not run it.

*Automation:* `runtime-restart-recovery.test.ts`.
