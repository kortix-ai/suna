---
recorded: 2026-10-28T12:53:21Z
incident_date: 2026-10-28
---
# Restore every rewritten package.json when smoke:install is killed by a signal

**Rule:** A script that rewrites a tracked file restores it on SIGTERM and SIGINT, not only in `finally`. Agents that share one worktree never run `pnpm worktree stop` while another agent's commands run there.

**Trigger surface:** Running or editing `packages/sdk/scripts/smoke-install.mjs` (`smoke:install`), or any script that stages a temporary `package.json`. Stopping a worktree that other agents use.

**Incident:** 2026-10-28, PR #10990. Parallel agents shared one worktree. A parallel `pnpm worktree stop` killed processes under the worktree path and SIGTERM'd `smoke:install` twice mid-run. Node exited without its `finally`, so `packages/sdk/package.json` and `packages/llm-catalog/package.json` stayed at version `0.0.0-smoke`. They were restored by hand from the script's tmpdir backups.

**Enforcement:** none yet: the smoke script needs a signal handler (`process.on('SIGTERM'|'SIGINT')`) that runs the same restore steps as its `finally`.
