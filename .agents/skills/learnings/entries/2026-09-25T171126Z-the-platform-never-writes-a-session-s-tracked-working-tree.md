---
recorded: 2026-09-25T17:11:26Z
incident_date: 2026-09-18
commit: cd6b6ab7af
---
# The platform never writes a session's tracked working tree

**Near miss.** `kortix sessions reload` exited 0 and printed a moved etag on dev
session `6d8dfdae`, which nobody had touched. The live agent answered
`NO_MARKER`. OpenCode read its agents, skills and tools from
`/workspace/.kortix/opencode`, so the reload checked the base branch's copy out
into the session's tracked tree. A scripted run on the #7403 preview then found
the consequences one at a time, each behind green unit tests: the platform's own
plugin pin, lockfile and skill overlay read as session edits; the previous
sync's unstaged output read as an edit; and an agent's `git add -A` swept the
synced bytes into a session commit. Measured with real git: the change request
listed the agent prompt as modified by the session, and its merge conflicted on
a file nobody in the session had touched. Auto-converging on every wake would
have made that fleet-wide.

**Rule.** Runtime state that the platform owns lives outside the repository.
Never write platform output into a tracked working tree and then try to tell it
apart from user work by reading `git status`. Verify a config reload by what
OpenCode serves (`/agent`, `/skill`), never by the etag. A daemon-side result is
evidence only when `health.runtime.components.agent` is `current`: a fresh
sandbox boots the template-baked daemon.

**Enforcement.** `boot-config.test.ts` and `config-dir-sync.test.ts` run against
real git repositories, full and `--depth 1`. They assert that `git status` in
the session stays empty after every convergence, that a session edit keeps the
working tree, and that a tampered or extended copy is rebuilt before a spawn.
