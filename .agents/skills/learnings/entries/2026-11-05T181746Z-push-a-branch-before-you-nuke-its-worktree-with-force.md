---
recorded: 2026-11-05T18:17:46Z
incident_date: 2026-11-05
---
# Push a branch before you nuke its worktree with --force

**Rule:** Push a branch before `pnpm worktree nuke <name> --force`. `--force`
used to run `git branch -D` on the worktree's branch, which deleted unmerged
and unpushed commits with no prompt.

**Trigger surface:** Freeing disk or switching a worktree's database mode
(shared → `--db` needs nuke and recreate) while the branch exists only locally.

**Incident:** 2026-11-05, near-miss. The `/work` volume filled (98 GB, no
autogrow) during the Workspaces branch. To switch the `workspaces` worktree to
its own database, it was nuked with `--force`. That deleted the local
`workspaces` branch: 60 commits ahead of `dev`, never pushed. It was restored
from its known head SHA with `git branch workspaces 5013c9fbd0` (the objects
survive until `git gc`) and pushed at once. No work was lost.

**Enforcement:** `scripts/worktree/cli.ts` (nuke): `--force` now deletes the
branch only when `git rev-list --count <branch> --not --remotes` is 0; else it
keeps the branch and prints how to drop it by hand. `scripts/worktree/README.md`
states the rule.
