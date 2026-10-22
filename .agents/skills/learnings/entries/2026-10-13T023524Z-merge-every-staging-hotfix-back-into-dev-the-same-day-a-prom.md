---
recorded: 2026-10-13T02:35:24Z
incident_date: 2026-10-13
---
# Merge every staging hotfix back into dev the same day; a promotion that conflicts with staging runs no workflow

**Rule:** Before pushing a `promote/dev-*` branch, run `git merge-tree --write-tree origin/staging <sha>`. On a conflict, push a merge of the green dev SHA into `origin/staging`, resolved so `git diff --quiet <sha>` passes (the tree equals the tested SHA). When a hotfix lands on `staging`, squash-merge its content into `dev` the same day.

**Trigger surface:** merging a `hotfix/*` PR into `staging`; opening a `promote/dev-*` PR (kortix-release, Step 2).

**Incident:** 2026-10-13, v0.13.57 promotion #9701. `staging` held #9634, #9591 and promotion-merge test fixes that never reached `dev`. The promotion of green dev SHA `8ebedfb9fb` conflicted in 2 files. A conflicting PR gets no merge ref, so GitHub started no `pull_request` workflow: the PR sat with only the dev push run's checks and looked half green. Earlier releases resolved the drift with an unchecked merge commit on each promotion branch; the green-SHA flow (#9626) first assumed none was needed.

**Enforcement:** kortix-release Step 2 (the merge-tree check and the tree-equality check). `dev` accepts only squash merges (ruleset `dev-push-protection`), so `staging` can never become an ancestor of `dev`; a merge-commit back-merge (tried in #9702) is refused. None automated yet: the enforcer to build is a check in `promote`-time tooling that fails a conflicting promotion before the PR opens.
