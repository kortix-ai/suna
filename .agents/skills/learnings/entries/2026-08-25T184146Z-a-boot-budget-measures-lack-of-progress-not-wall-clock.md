---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# A boot budget measures lack of progress, not wall-clock

*Incident (2026-08-25 17:23–17:25, SampleCo):* both reopened sessions failed
to wake. The resume converged OpenCode 1.18.19 → 1.18.23 (manifest bump live
since the updater restarted the API) and then sat through the new version's
53 s first init. `/start` polled `starting` for 83 s and the fixed
`STALE_OPENCODE_NOT_READY_MS = 90 s` budget parked both boxes as
`runtime_boot_failed`; the automatic restart then booted in 20 s because the
install had already landed.

**Rules.**
1. Every not-ready 503 from the daemon carries `X-Kortix-Boot-Phase`
   (`boot-phase.ts`: last boot mark, OpenCode state, runtime-assets activity
   such as `installing-opencode@<v>`, and the not-ready reason).
2. The API restarts the per-reason clock whenever that phase changes
   (`opencodeReadyWaitPatch`); `STALE_OPENCODE_NOT_READY_MS` now bounds time
   without progress. `STALE_OPENCODE_BOOT_HARD_MS` (10 min from first
   observation) bounds a boot that changes phase forever. A stub launcher
   respawning in a loop never changes phase and is still caught at 90 s.
3. Do not "fix" a slow legitimate boot by raising the fixed budget; expose the
   progress and budget that.

*Automation:* `session-lifecycle/readiness-clocks.test.ts` ("progress-aware
OpenCode boot budget"), `boot-phase.test.ts`, `proxy-auth.test.ts` ("names the
boot phase").
