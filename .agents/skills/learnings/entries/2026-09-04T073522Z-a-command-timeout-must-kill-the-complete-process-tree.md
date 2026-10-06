---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A command timeout must kill the complete process tree

**When:** enforcing a timeout on a shell command that can fork child processes.
**Incident:** env-rpc killed only the parent shell; a child kept the output pipes open and a
200 ms timeout returned after 5 seconds.
**Rule:** start each command in its own process group and signal the group on timeout.
**Enforcer:** `env-rpc.test.ts` requires a forked five-second command to return within 1.5 seconds.
