---
recorded: 2026-10-10T16:44:14Z
incident_date: 2026-10-09
---
# A background agent must exit when its own binary changes on disk, and must own the daemon socket it starts

**Rule:** A supervised background process (the agent-tunnel service) exits when a
file it runs from changes on disk, and lets its supervisor restart it. On macOS a
process whose binary an app update replaced fails code-signature validation, and
TCC then refuses it Accessibility and Screen Recording while the updated app shows
them granted. A process that starts a daemon on a socket removes a socket it did
not just create before it starts, and never adopts a daemon it did not start: the
driver refuses to start over an existing endpoint, and an adopted daemon runs
outside the process's macOS permissions.

**Trigger surface:** Changing `packages/agent-tunnel` service mode, the embedded
cua-driver lifecycle (`capabilities/desktop/cua-driver.ts`), the desktop app's
auto-update, or anything that restarts the agent (pause/resume, Allow all, crash).

**Incident:** 2026-10-09, desktop 0.13.53 with agent 0.1.2. An auto-update replaced
Kortix.app under a running agent. Every desktop call on that computer failed with
"Accessibility is NOT granted" while Your computer showed Screen & keyboard
Allowed. A restart then left a stale driver socket, and every desktop call failed
with "daemon is not running" until the file was removed by hand. Agents were told
to re-pair, which fixes neither.

**Enforcement:** `packages/agent-tunnel/src/agent/self-restart.test.ts` (an in-place
binary swap changes the runtime fingerprint) and
`capabilities/desktop/cua-driver.test.ts` ("a socket left by a previous agent is
stopped and removed", "a daemon that does not start fails the call").
