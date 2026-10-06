---
recorded: 2026-09-01T18:07:33Z
incident_date: 2026-09-01
commit: 32a38fa91e
---
# A test that SIGKILLs a child orphans its grandchildren, and a leaked listener poisons a fixed port range

**When:** any test that spawns a process which itself spawns another (a
supervisor, a park/handoff script, a dev server that forks). `child.kill()`
reaches only the direct child; the grandchild is reparented to init and KEEPS
its port bound. 42 had accumulated on one machine, each squatting a port in the
helper's `18800 + random(500)` range, so a later boot drew a stranger's worker,
got `{runtimeReady:true}` with no `parked` field, and the assertion failed on
`parked === undefined` — 1 run in 6, at a rate that climbed with every run and
therefore looked like a change-induced regression rather than a leak.
**Rules:** (1) `spawn(..., { detached: true })` and kill the process GROUP
(`process.kill(-pid, 'SIGKILL')`) — the group id survives reparenting, so it
reaches the orphans; (2) never pick a test port from a fixed range — bind `0`,
read the assigned port, close, use it; (3) a flake whose rate RISES across a
session is accumulating state on the machine — count the processes before
blaming the diff.
**Diagnostic:** `lsof -nP -iTCP -sTCP:LISTEN` in the range, plus
`ps -o pid,ppid,pgid,command` showing `ppid=1`.
*Enforcer:* `killTree()` + `freePort()` in `pi-worker-park.test.ts`; 12/12 clean
and 0 new leaks afterwards.
