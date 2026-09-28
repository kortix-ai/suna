---
recorded: 2026-09-26T00:18:20Z
incident_date: 2026-09-26
---
# Never pkill a dev stack by script name: it matches every checkout

**Rule:** Stop a dev stack by its port or its process group, never by
`pkill -f dev-local.sh`. Every worktree runs the same script name, so the
pattern matches every checkout on the machine and kills stacks you do not own.
Resolve the owner first — `lsof -iTCP:<port> -sTCP:LISTEN -P -n` names the pid
that holds the port you started — and kill that pid.

**Trigger surface:** Stopping, restarting, or cleaning up a local stack started
with `pnpm dev` / `scripts/dev-local.sh`, especially while another worktree's
stack is running. Also any `pkill -f` against a path-independent pattern.

**Incident:** 2026-09-26, near-miss, no customer impact. A worktree stack was
started to get real-box evidence for a branch. It bound 3000/8008 instead of
its assigned worktree port block, colliding with the primary checkout's stack.
The cleanup used `pkill -f dev-local.sh`, which matched both, and the primary
checkout's API and web server went down with it. Detected by the next
`/v1/health` call returning nothing; the primary stack was restarted from its
own checkout and confirmed healthy (`200`, tunnel up, both providers loaded).

**Enforcement:** none yet: a `scripts/dev-local.sh` stop path that writes its
pid file per checkout and a `pnpm dev:stop` that reads it, so stopping a stack
never needs a name pattern. Until that exists, the rule is the enforcer.
