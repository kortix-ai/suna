---
recorded: 2026-10-22T18:21:10Z
incident_date: 2026-10-22
---
# Create the vX.Y.Z tag with a workflow-scoped token when dev's workflow files changed after the Promote

**Rule:** When `Deploy Prod`'s `GitHub Release` job fails with `403 Resource not accessible by integration`, compare `.github/workflows` between the release merge commit and `origin/dev` (`git diff --name-only <merge> origin/dev -- .github/workflows`). If they differ, the job's `GITHUB_TOKEN` may not create the new tag. Create it at the release merge commit with a token that has the `workflow` scope (`gh api repos/kortix-ai/suna/git/refs -f ref=refs/tags/vX.Y.Z -f sha=<merge sha>`), then rerun the failed jobs. Never retag another commit.

**Trigger surface:** Merging a release PR into `prod` while workflow PRs (Dependabot action bumps) merge into `dev`; reading a red `GitHub Release` job.

**Incident:** v0.14.6, 2026-10-22. Five Dependabot action bumps merged into `dev` at 17:04Z, one minute after the release merge. At 17:23Z, 21 workflow files differed between the release commit and `dev` (0 at v0.14.5). The `GitHub Release` job got 403 on create. After the tag was created with a workflow-scoped token, the create succeeded, but the asset upload timed out twice on a `vulcan` runner (rule 2026-10-19, `CI_RUNNER_M_2204` set to `ubuntu-22.04` for the rerun). The release stayed a draft from 17:23Z to 18:17Z; the installers, Slack announcement and VERSION sync waited for it.

**Enforcement:** none yet. The enforcer to build: `deploy-prod.yml` creates the tag before `softprops/action-gh-release`, with a GitHub App token that has the `workflows` permission.
