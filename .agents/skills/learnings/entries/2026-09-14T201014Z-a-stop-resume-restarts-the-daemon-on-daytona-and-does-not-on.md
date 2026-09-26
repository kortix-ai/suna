---
recorded: 2026-09-14T20:10:14Z
incident_date: 2026-09-14
commit: ccd3f7596d
---
# A stop → resume restarts the daemon on Daytona and does NOT on Platinum — never assume boot-time work re-runs after a resume

**When:** writing anything that expects the sandbox daemon's boot path (config
provider, reconcile, warm adoption, a health summary) to run again after
`/sessions/:id/stop` + `/start`, or a check that reads the post-resume health
as if it were a fresh boot. Daytona restarts the container, so the daemon
re-runs and adopts the workspace warm (`provider: git`, `timings: {warm: ~230}`).
Platinum CoW-resumes the SAME VM with the same process: `opencode_pid`
unchanged, `uptime_s` carried on, and the health endpoint still reports the
ORIGINAL boot's `config_provider` (`provider: s3, s3_attempted: true`) — which
reads exactly like a re-acquisition and is not one (the uncommitted file is
still on disk). Make the assertion provider-agnostic: "never re-acquired" is
either "restarted + adopted warm" or "same daemon continued (summary identical,
uptime ≥ before)"; a real re-acquisition shows NEW timings.
*Near-miss:* the S3 compat gate's first Platinum run (PR #7221) failed its
resume step on this and would have blocked a green provider; cost one run.
*Enforcer:* `project-snapshot-compat.ts` prints `adoptedWarm` / `daemonContinued`
per run and passed 23/23 on both providers; nothing yet guards other resume
assumptions (`scheduleSandboxRuntimeRefresh` exists for the reconcile case).
