---
recorded: 2026-08-26T13:06:00Z
incident_date: 2026-08-26
commit: 97b81a45d1
---
# A provider's "resume" is not a promise that your processes come back

**When:** using any pause/resume sandbox lifecycle that persists the filesystem
only. E2B's `lifecycle.autoResume` requires a MEMORY snapshot; with
`keepMemory:false` the SDK documents the box as cold-booting and needing an
explicit `connect()`, and Kortix sets no template `startCmd` — so apps/api is
the only thing that starts the runtime. Resumes that came back with a dead
process tree burned the full 190 s health wait and handed back an unreachable
box; only a human restart (a NEW sandbox) healed it. Rule: **after a resume,
prove the daemon answers on a short bound; if it does not AND no supervisor
process is alive, clear the stale lock, relaunch once, re-verify, and log the
workaround under one greppable string so its rate is countable.** Never `rm` a
flock'd lock while a live holder exists — that does not free the lock, it lets a
second daemon win a different inode. *Enforcer:* `e2b.test.ts` — dead resume is
revived and re-verified, a healthy resume touches nothing, a merely-slow resume
is never double-started.
