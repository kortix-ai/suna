---
recorded: 2026-10-13T02:35:24Z
incident_date: 2026-10-13
---
# Merge every staging hotfix back into dev the same day; a promotion that conflicts with staging runs no workflow

**Rule:** When a hotfix branch merges into `staging`, merge `origin/staging` back into `dev` through a PR the same day. Before a promotion, run `git merge-base --is-ancestor origin/staging origin/dev`; when it fails, back-merge first and promote a green SHA after that merge.

**Trigger surface:** merging a `hotfix/*` PR into `staging`; opening a `promote/dev-*` PR (kortix-release, Step 2).

**Incident:** 2026-10-13, v0.13.57 promotion #9701. `staging` held #9634, #9591 and promotion-merge test fixes that never reached `dev`. The promotion of green dev SHA `8ebedfb9fb` conflicted in 2 files. A conflicting PR gets no merge ref, so GitHub started no `pull_request` workflow: the PR sat with only the dev push run's checks and looked half green. Earlier releases hid the drift with a merge commit on each promotion branch, which the green-SHA flow (#9626) no longer allows.

**Enforcement:** the ancestor check in kortix-release Step 2. None automated yet: the enforcer to build is a step in `promote`-time tooling (or a scheduled job) that fails when `origin/staging` is not an ancestor of `origin/dev`.
