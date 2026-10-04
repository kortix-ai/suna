---
recorded: 2026-10-01T06:19:54Z
incident_date: 2026-10-01
---
# A denied built-in permission must also deny the custom tools that do the same job (bash: deny -> pty_*, edit: deny -> memory)

**Rule:** When an agent denies `bash` or `edit`, deny every custom tool that runs a shell or writes files (`pty_*`, `memory`) in the same compiled permission. OpenCode matches a custom tool by its own name, and the starter `pty_*` plugin reads the global config, not the agent's rules.

**Trigger surface:** Adding or compiling an agent permission policy; adding a custom tool that spawns processes or writes files.

**Incident:** 2026-10-01, release gate RUN-10 on a staging candidate: the `no-edit` agent (`edit`, `bash`, `task` denied) created a file. A dev session showed `pty_spawn` and `memory` callable by that agent; `pty_spawn` ran with status `completed`. Exposed: any project whose agent denies `bash` or `edit` and ships the starter tools, on every release including v0.13.45. Fixed in the compiler (apps/api `denyToolsBehindDeniedPermission`).

**Enforcement:** `apps/api/src/services/projects/lib/compile-agent-config.test.ts` (denied bash/edit denies pty_* and memory) and flow `RUN-10`, which now fails on any non-error `memory` or `pty_*` call.
