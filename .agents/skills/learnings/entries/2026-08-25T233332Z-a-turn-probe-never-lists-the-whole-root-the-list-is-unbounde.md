---
recorded: 2026-08-25T23:33:32Z
commit: ed74e34af4
---
# A turn probe never lists the whole root — the list is unbounded, the budget is not

*Incident (2026-08-25, SampleCo sessions 9c8749ac and 9df2a873):* the reaper
asks the daemon `GET /kortix/health?turn=1&turn_session_id&turn_message_id`
and acts on `turn_in_flight`. The daemon answered it by fetching the root's
ENTIRE OpenCode message list inside a 5 s budget. On 9c8749ac that list was
276.7 MB (inline base64 image parts; `?limit=20` alone was 26 MB). The read
never fit, the daemon answered `turn_in_flight: null` ("could not tell") on
every visit, the reaper drip-extended the box on that non-answer for 2.5 h
after OpenCode had finished the turn (`exiting loop` 21:00:18Z, probe still
null at 22:10Z), and the session rendered "working" until the ledger row was
settled by hand.

**Rules.**
1. `observeOpencodeDelivery` / `inspectOpencodeRoot` read the newest
   `TURN_PROBE_WINDOW` (12) messages via `?limit=` — the newest N in
   chronological order (verified on OpenCode 1.18.23) — with a 20 s budget.
   A prompt older than the window is proved by `GET /session/:id/message/:id`
   (~400 bytes; 404 `NotFoundError` when absent). Only a proven absence is
   `abandoned`; a failed by-id read stays `null`.
2. Any new daemon read of a session transcript states its bound in the
   request. Roots grow for hours; "the list" is never small.
3. The live opencode port is a property of the PROCESS (`childPorts`,
   `livePort()` in opencode.ts), never a variable beside it. Same box, same
   day: the daemon reported `starting` on 4096 for 2 h while its own child
   (pid 2423) served on 4097 — every prompt 503'd and no turn end was ever
   observed. The verified reload (two opencodes, promote the proven one) is
   by design; a bookkeeping variable that can drift from the process is not.
   The verifier also declines when the candidate half already answers: the
   incumbent would otherwise "prove" a candidate that died on EADDRINUSE and
   promotion would kill the only opencode the box has.
4. The daemon log is on the box: every logger line also lands in
   `KORTIX_DAEMON_LOG_FILE` (default `/opt/kortix/logs/daemon.log`, rotated at
   32 MiB to `.1`), readable with `GET /kortix/logs?source=daemon|opencode|all&tail=N`
   through the sandbox proxy (`/v1/p/<external_id>/8000/kortix/logs`). A
   daemon whose only log is a stream nobody keeps cannot be debugged after
   the fact — that is why this entry says "unproven".
5. Box telemetry is on record: `[resources]` every 60 s and on every OpenCode
   state change (memory, cgroup limit + oom_kill counter, load, disk on
   /workspace + /opt/kortix + /tmp, daemon + opencode RSS, duplicate
   `opencode serve` pids), `[resources] pressure` when a threshold is
   crossed, and `GET /kortix/diag` returns state + resources + runtime
   report + both log tails in one document. Ask the box before guessing.

*Cost of the old probe, measured (2026-08-25 23:12Z, session 9df2a873):* the
reaper visited that box 345 times in one hour; every visit made OpenCode
JSON-serialise its 140 MB root (~48 GB of serialisation per hour) for an
answer that never fit the budget. OpenCode reached 6.48 GB RSS on an 8 GB
box and the kernel OOM-killed it mid-turn (`dmesg`: `Killed process 1506
(opencode.exe) anon-rss:6484532kB`). An unbounded probe is not only blind,
it is a memory attack on the process it probes.

*Automation:* `orphaned-turn-finalize.test.ts` ("turn probes read a bounded
window, never the whole root"); the stub fetch there serves `?limit=` and
`/message/:id` the way 1.18.23 does.
