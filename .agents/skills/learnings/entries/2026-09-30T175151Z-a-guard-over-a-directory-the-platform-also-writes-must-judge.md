---
recorded: 2026-09-30T17:51:51Z
incident_date: 2026-09-30
supersedes: 2026-09-30T171738Z-when-a-mechanism-moves-behind-a-flag-keep-the-flag-off-path.md
---
# A guard over a directory the platform also writes must judge only the files its operation changes

**Rule:** A "do not overwrite the user's work" guard must look only at the files the operation would change. The platform writes into the OpenCode config dir of every live session (OpenCode's plugin install rewrites the tracked `package.json`, the managed-skill overlay rewrites `skills/kortix-*`), so "is anything under the dir dirty?" is always yes. `syncConfigDirToBase` works file by file over what base changed since the session forked (`merge-base`): already-base files are skipped, files the session committed or edited are kept (`kept`), the rest are brought in. The superseded entry's rule stands: the flag-off reload path keeps this sync.

**What changed vs the superseded entry:** its Incident line said current daemons skip the governance push on a flag-off project, so OpenCode was not restarted. Wrong: `daemonHasConfigReleases` is true only while a release is served, so the push runs and disposes OpenCode; the reload restarted it with the old file still in the checkout. And the restored whole-directory guard refused on every live box.

**Incident:** 2026-09-30 on dev, after #8482: a fresh session with repository access and no edits of its own reported `agent_files: kept-yours`; `git status` showed only `package.json` and 17 `skills/kortix-*` files modified by the platform. Fixed in the follow-up PR: per-file guard, and a dispose-first config reload on sync.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/config-dir-sync.test.ts` › "files base did not change never block it", "an untracked file where base ADDS one is kept", "base changes two files and the session edited one", "a file base deleted is removed" (real git), and `refresh-route.test.ts` › `base_config=1` rows.
