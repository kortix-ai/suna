---
recorded: 2026-08-23T14:10:45Z
incident_date: 2026-08-23
commit: bf1147e881
---
# Keep the legacy relay until old sessions pass a real cutover gate

**When:** replacing sandbox runtime startup, ingress, or relay ownership.
Do not merge the cutover until one pre-change session passes chat, files, PTY,
idle survival, and stop/start recovery through the browser. A persistent boot
lock must record the boot ID and owner PID, and recover an empty or stale lock.
*Incident:* PRs #6686 and #6773–#6786 moved the relay to `kortixd`; an empty
`/opt/kortix/bootstrap.lock` then blocked every later wake for that node.
*Enforcer:* TODO: add the pre-change-session journey to the browser release gate.
