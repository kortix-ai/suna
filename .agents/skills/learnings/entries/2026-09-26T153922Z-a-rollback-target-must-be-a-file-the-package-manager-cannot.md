---
recorded: 2026-09-26T15:39:22Z
incident_date: 2026-09-26
---
# A rollback target must be a file the package manager cannot delete, not a path it owns

**Rule:** Record a rollback target by RETAINING the bytes — hard-link the resolved binary
aside, copy it on EXDEV/EPERM — never by storing a path or a symlink into a package
manager's store. And write the "do not try again" latch on BOTH branches: a box that is
down and latched gets a human, a box that is down and unlatched repeats the failure at
every start.

**Trigger surface:** Adding or reviewing self-update, rollback, or pin behaviour in
`apps/kortix-sandbox-agent-server/src/harness/**` or `runtime-assets.ts`, and any code that
resolves a binary out of `pnpm`'s global virtual store.

**Incident:** 2026-09-26, found in review on `feat/runtime-assets-at-send` before it
shipped. `recordOpencodePrevious` stored `readlink(opencode.current)`, which points into
pnpm's global store. `pnpm add -g opencode-ai@<new>` deletes the version it replaces, so
the rollback's `stat` threw ENOENT BEFORE the pin latch was written: the box stayed down
and the next pass reinstalled the same broken build. Measured in a container with the
image's pnpm layout — the recorded path was gone and `opencode.current` dangled, while a
hard link taken before the install still ran. Blast radius would have been every sandbox
taking an OpenCode update that failed to serve.

**Enforcement:** `runtime-convergence.test.ts` -> `the rollback survives pnpm deleting the
version it replaced`, which drives `installOpencode` the way `pnpm add -g` really behaves
instead of stubbing it, and asserts the latch is written.
