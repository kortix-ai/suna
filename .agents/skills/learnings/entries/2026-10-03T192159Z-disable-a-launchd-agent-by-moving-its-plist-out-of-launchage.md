---
recorded: 2026-10-03T19:21:59Z
incident_date: 2026-10-02
---
# Disable a launchd agent by moving its plist out of LaunchAgents, never by bootout alone

**Rule:** To stop a local launchd job for good, run `launchctl bootout gui/$(id -u)/<label>` AND move
`~/Library/LaunchAgents/<label>.plist` to a disabled directory. Then kill any detached child loops
(`ps -axo pid,command | grep -F <job dir>`). `bootout` alone unloads the job until the next login only.

**Trigger surface:** Stopping a long-running local job that talks to a deployed environment: a
migration fleet, a rehome or backfill loop, a watchdog, or a dashboard started from a worktree.

**Incident:** 2026-10-01: a local legacy-transfer rehome fleet (10 `ai.kortix.*` launchd agents in
a worktree, running with `apps/api/.env.prod`) was stopped with `bootout` because it retried its
last ~35 sessions forever (~6,400 prod `/start` calls per hour as one user). The plists stayed in
`~/Library/LaunchAgents`. The Mac rebooted 2026-10-02 15:41. At login launchd reloaded all 10
agents. The fleet ran against prod for ~27 h, and nobody knew. A disk cleanup on 2026-10-03 found
it as "a 34 GB worktree with live processes". Bootout did not kill 11 detached `while true` shell
loops; they needed `kill`.

**Enforcement:** none yet: a `launchctl list | grep ai.kortix` check in the worktree skill's
`doctor`, flagging any loaded agent whose plist points into a worktree.
