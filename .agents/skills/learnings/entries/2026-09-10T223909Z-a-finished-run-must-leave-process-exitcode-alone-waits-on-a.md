---
recorded: 2026-09-10T22:39:09Z
incident_date: 2026-09-10
commit: af4c587d4b
---
# A finished run must LEAVE — `process.exitCode` alone waits on a loop one leaked handle keeps alive forever

**When:** writing the completion path of any long-running CLI, test runner, or
worker. Setting `process.exitCode` and returning is not "exit"; it is "exit once
the event loop drains". One un-closed socket, stream, pool, or interval makes
that never. Release gate run 34510198802, api shard 4 printed its verdict —
`results: 82/84 passed · 1 failed · 1 skipped` — at 18:44:39, then sat idle for
40 minutes and was killed by the job's 60-minute cap at 19:24:50. Shard 5 exited
16 s after its last flow; the difference was RUN-7, whose
`POST /sessions/:id/start?wait_ms=8000` timed out and left a handle behind.
The cost was not the leak: it was that `cancelled` REPLACED a real verdict of
one failed flow, poisoned `needs.api.result`, and failed `full suite + quality
gates` for the entire promote. **Rules.** (1) Once the verdict is decided and
the report written, give the loop a short grace period, then exit anyway.
(2) Always log that you had to — a forced exit is evidence of a leak, and
swallowing it trades a visible 40-minute hang for an invisible bug. (3) Make the
grace period configurable to zero so the leak can still be debugged by hand.
(4) An `unref`'d timer is the right tool: it never keeps an idle process alive,
and it still fires when something else is holding the loop open. *Enforcer:*
`tests/unit/exit-once-decided.test.ts` spawns real processes — leak plus fix
exits with the verdict intact, leak plus grace 0 hangs, no leak does not delay
or warn.
